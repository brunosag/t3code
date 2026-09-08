// @effect-diagnostics nodeBuiltinImport:off globalTimers:off -- Node subprocess callback boundary: direct child_process stdio framing and setTimeout request/kill timers outside any Effect runtime.
/**
 * PiRpcClient — JSONL transport for `pi --mode rpc`.
 *
 * Spawns the binary with `["--mode", "rpc"]` (plus `--session` when given),
 * correlates `request()` calls with `response` envelopes by id, and forwards
 * other envelopes to `onEvent`. Any transport failure rejects pending work
 * and reports via `onExit` once; `close()` stops the owned child and never
 * reports via `onExit`.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeStringDecoder from "node:string_decoder";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/** Options for {@link PiRpcClient}. */
export interface PiRpcClientOptions {
  /** Absolute path (or PATH-resolvable name) of the `pi` binary to spawn. */
  readonly binaryPath: string;
  /** Working directory the child process runs in. */
  readonly cwd: string;
  /** Complete environment for the child, passed through as-is. */
  readonly environment: NodeJS.ProcessEnv;
  /** Optional session file, forwarded as `--session <path>`. */
  readonly sessionPath?: string;
  /** Receives every stdout envelope that is not a correlated `response`. */
  readonly onEvent: (event: Record<string, unknown>) => void;
  /** Called exactly once when the transport fails outside `close()`. */
  readonly onExit: (error: Error) => void;
  /** Per-request timeout in milliseconds. Defaults to 60 seconds. */
  readonly requestTimeoutMs?: number;
}

interface PendingRequest {
  readonly command: string;
  readonly resolve: (data: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
/** Upper bound for one buffered stdout line before the transport is failed. */
const MAX_LINE_CHARS = 4 * 1024 * 1024;
/** Retained stderr tail kept as an `Error` cause diagnostic. */
const MAX_STDERR_CHARS = 64 * 1024;
/** Wait after SIGTERM before escalating to SIGKILL. */
const STOP_TERM_TIMEOUT_MS = 2_000;
/** Bounded wait after SIGKILL before teardown gives up waiting. */
const STOP_KILL_TIMEOUT_MS = 2_000;

const RpcEnvelopeRecord = Schema.Record(Schema.String, Schema.Unknown);
const RpcEnvelopeFromJson = Schema.fromJsonString(RpcEnvelopeRecord);
const decodeJsonUnknown = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const decodeEnvelopeRecord = Schema.decodeUnknownOption(RpcEnvelopeRecord);
const encodeRpcMessage = Schema.encodeSync(RpcEnvelopeFromJson);

function toError(value: unknown, fallback: string): Error {
  if (value instanceof Error) return value;
  if (typeof value === "string" && value.length > 0) return new Error(value);
  return new Error(fallback);
}

export class PiRpcClient {
  private readonly binaryPath: string;
  private readonly requestTimeoutMs: number;
  private readonly onEventCallback: (event: Record<string, unknown>) => void;
  private readonly onExitCallback: (error: Error) => void;
  private readonly decoder = new NodeStringDecoder.StringDecoder("utf8");
  private readonly pending = new Map<string, PendingRequest>();

  private child: NodeChildProcess.ChildProcess | null = null;
  private nextRequestId = 0;
  private stdoutBuffer = "";
  private stderrTail = "";
  private failed: Error | null = null;
  private closing = false;
  private teardownPromise: Promise<void> | null = null;
  private exitNotified = false;

  constructor(options: PiRpcClientOptions) {
    this.binaryPath = options.binaryPath;
    this.onEventCallback = options.onEvent;
    this.onExitCallback = options.onExit;
    const timeout = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    if (!Number.isFinite(timeout) || timeout <= 0) {
      throw new Error(`pi rpc: requestTimeoutMs must be a positive number, got ${timeout}`);
    }
    this.requestTimeoutMs = timeout;

    const args =
      options.sessionPath !== undefined
        ? ["--mode", "rpc", "--session", options.sessionPath]
        : ["--mode", "rpc"];
    let child: NodeChildProcess.ChildProcess | null = null;
    try {
      child = NodeChildProcess.spawn(options.binaryPath, args, {
        cwd: options.cwd,
        env: options.environment,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      const failure = new Error(`pi rpc: failed to spawn "${options.binaryPath}"`, {
        cause: toError(error, "unknown spawn error"),
      });
      this.child = null;
      this.failed = failure;
      this.teardownPromise = Promise.resolve();
      queueMicrotask(() => {
        this.notifyExit(failure);
      });
      return;
    }
    this.child = child;
    child.on("error", (error) => {
      if (this.closing) return;
      const tail = this.stderrTail;
      const failure =
        tail.length > 0
          ? new Error(`pi rpc: process error for "${this.binaryPath}"`, {
              cause: new Error(tail, { cause: error }),
            })
          : new Error(`pi rpc: process error for "${this.binaryPath}"`, { cause: error });
      this.failTransport(failure);
    });
    child.on("close", (code, signal) => {
      if (this.closing) return;
      this.failTransport(this.exitError(code, signal));
    });
    child.stdout?.on("data", (chunk: Buffer | string) => {
      this.handleStdoutData(chunk);
    });
    child.stdout?.on("close", () => {
      if (this.closing || this.failed !== null) return;
      // Stdio closes before the child `close` event on exit; defer so the
      // exit handler (code/signal + stderr cause) wins. A standalone stdout
      // closure with a live child still fails after the grace window.
      const timer = setTimeout(() => {
        if (this.closing || this.failed !== null || this.hasExited()) return;
        this.failTransport(new Error("pi rpc: stdout closed unexpectedly"));
      }, 100);
      timer.unref();
    });
    child.stdout?.on("error", (error) => {
      if (this.closing || this.failed !== null) return;
      this.failTransport(
        new Error("pi rpc: stdout error", { cause: toError(error, "unknown stdout error") }),
      );
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      this.stderrTail = `${this.stderrTail}${text}`.slice(-MAX_STDERR_CHARS);
    });
    child.stderr?.on("error", () => {
      // Stderr is diagnostics only; errors here must not take the transport down.
    });
    child.stdin?.on("error", (error) => {
      if (this.closing) return;
      this.failTransport(
        new Error(`pi rpc: process stdin error for "${this.binaryPath}"`, { cause: error }),
      );
    });
  }

  /**
   * Send a command and resolve with the matching `response.data`.
   * Rejects when the response reports `success: false`, when the request
   * times out (which also fails the transport), or when the transport is
   * otherwise already dead.
   */
  request(type: string, fields: Record<string, unknown> = {}): Promise<unknown> {
    if (this.failed !== null) {
      return Promise.reject(this.failed);
    }
    const child = this.child;
    if (child === null || child.stdin === null || child.stdin.destroyed) {
      return Promise.reject(new Error("pi rpc: process is not running"));
    }
    this.nextRequestId += 1;
    const id = `req-${this.nextRequestId}`;
    const message: Record<string, unknown> = { ...fields, type, id };
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const timeoutError = new Error(
          `pi rpc: request "${type}" timed out after ${this.requestTimeoutMs}ms`,
        );
        reject(timeoutError);
        this.failTransport(timeoutError);
      }, this.requestTimeoutMs);
      timer.unref();
      this.pending.set(id, { command: type, resolve, reject, timer });
      this.writeLine(message);
    });
  }

  /**
   * Write a fire-and-forget message (e.g. an `extension_ui_response`) without
   * expecting a correlated response. Throws when the transport is closed.
   */
  send(message: Record<string, unknown>): void {
    const before = this.failed;
    if (before !== null) {
      throw new Error(`pi rpc: cannot send, transport is failed: ${before.message}`);
    }
    if (typeof message.type !== "string") {
      throw new Error("pi rpc: send() requires a message with a string type");
    }
    this.writeLine(message);
    const after = this.failed;
    if (after !== null) {
      throw new Error(`pi rpc: failed to send "${message.type}": ${after.message}`);
    }
  }

  /**
   * Stop the owned child (SIGTERM, then bounded SIGKILL) and resolve once it
   * exits. Idempotent; never reports via `onExit`.
   */
  close(): Promise<void> {
    if (this.teardownPromise !== null && this.closing) {
      return this.teardownPromise;
    }
    this.closing = true;
    const closedError = new Error("pi rpc: client is closed");
    if (this.failed === null) {
      this.failed = closedError;
    }
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(closedError);
    }
    this.pending.clear();
    this.child?.stdout?.removeAllListeners("data");
    return this.ensureTeardown();
  }

  private writeLine(message: Record<string, unknown>): void {
    if (this.failed !== null) {
      return;
    }
    const child = this.child;
    if (child === null || child.stdin === null || child.stdin.destroyed) {
      this.failTransport(new Error("pi rpc: process stdin is unavailable"));
      return;
    }
    let line: string;
    try {
      line = `${encodeRpcMessage(message)}\n`;
    } catch (error) {
      this.failTransport(
        new Error("pi rpc: failed to serialize message", {
          cause: toError(error, "unknown error"),
        }),
      );
      return;
    }
    try {
      child.stdin.write(line, "utf8");
    } catch (error) {
      this.failTransport(
        new Error("pi rpc: failed to write message", {
          cause: toError(error, "unknown error"),
        }),
      );
    }
  }

  private handleStdoutData(chunk: Buffer | string): void {
    if (this.failed !== null || this.child === null) {
      return;
    }
    this.stdoutBuffer += typeof chunk === "string" ? chunk : this.decoder.write(chunk);
    let newlineIndex = this.stdoutBuffer.indexOf("\n");
    while (newlineIndex !== -1) {
      let line = this.stdoutBuffer.slice(0, newlineIndex);
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      if (line.endsWith("\r")) {
        line = line.slice(0, -1);
      }
      if (line.length > MAX_LINE_CHARS) {
        this.failTransport(
          new Error(`pi rpc: stdout line exceeds ${MAX_LINE_CHARS} characters, failing transport`),
        );
        return;
      }
      if (line.length > 0) {
        this.handleLine(line);
        if (this.failed !== null) {
          return;
        }
      }
      newlineIndex = this.stdoutBuffer.indexOf("\n");
    }
    if (this.stdoutBuffer.length > MAX_LINE_CHARS) {
      this.failTransport(
        new Error(`pi rpc: stdout line exceeds ${MAX_LINE_CHARS} characters, failing transport`),
      );
    }
  }

  private handleLine(line: string): void {
    const json = decodeJsonUnknown(line);
    if (Option.isNone(json)) {
      this.failTransport(new Error("pi rpc: invalid JSON from process"));
      return;
    }
    const record = decodeEnvelopeRecord(json.value);
    if (Option.isNone(record)) {
      this.failTransport(new Error("pi rpc: malformed envelope without a string type"));
      return;
    }
    const envelope: Record<string, unknown> = { ...record.value };
    if (typeof envelope["type"] !== "string") {
      this.failTransport(new Error("pi rpc: malformed envelope without a string type"));
      return;
    }
    if (envelope["type"] === "response") {
      this.handleResponse(envelope);
      return;
    }
    try {
      this.onEventCallback(envelope);
    } catch (error) {
      this.failTransport(
        new Error("pi rpc: onEvent threw", { cause: toError(error, "unknown error") }),
      );
    }
  }

  private handleResponse(envelope: Record<string, unknown>): void {
    const id = envelope["id"];
    if (typeof id !== "string" && typeof id !== "number") {
      return;
    }
    const key = String(id);
    const pending = this.pending.get(key);
    if (pending === undefined) {
      return;
    }
    const responseCommand = envelope["command"];
    if (typeof responseCommand === "string" && responseCommand !== pending.command) {
      this.pending.delete(key);
      clearTimeout(pending.timer);
      const failure = new Error(
        `pi rpc: mismatched response command for "${pending.command}": got "${responseCommand}"`,
      );
      pending.reject(failure);
      this.failTransport(failure);
      return;
    }
    this.pending.delete(key);
    clearTimeout(pending.timer);
    if (envelope["success"] === true) {
      pending.resolve(envelope["data"]);
      return;
    }
    if (envelope["success"] === false) {
      const detail =
        typeof envelope["error"] === "string" && envelope["error"].length > 0
          ? envelope["error"]
          : `command "${pending.command}" failed`;
      pending.reject(new Error(`pi rpc: ${detail}`));
      return;
    }
    const failure = new Error(
      `pi rpc: malformed response for "${pending.command}" without boolean success`,
    );
    pending.reject(failure);
    this.failTransport(failure);
  }

  private exitError(code: number | null, signal: NodeJS.Signals | null): Error {
    const tail = this.stderrTail;
    const message =
      `pi rpc: process "${this.binaryPath}" exited unexpectedly ` +
      `(code=${code} signal=${signal})`;
    return tail.length > 0 ? new Error(message, { cause: new Error(tail) }) : new Error(message);
  }

  private failTransport(error: Error): void {
    if (this.failed !== null) {
      return;
    }
    this.failed = error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.child?.stdout?.removeAllListeners("data");
    this.notifyExit(error);
    void this.ensureTeardown();
  }

  private notifyExit(error: Error): void {
    if (this.exitNotified) {
      return;
    }
    this.exitNotified = true;
    try {
      this.onExitCallback(error);
    } catch {
      // Host callback errors must not break transport teardown.
    }
  }

  private hasExited(): boolean {
    const child = this.child;
    if (child === null) {
      return true;
    }
    return child.exitCode !== null || child.signalCode !== null;
  }

  private ensureTeardown(): Promise<void> {
    if (this.teardownPromise !== null) {
      return this.teardownPromise;
    }
    const child = this.child;
    if (child === null || this.hasExited()) {
      this.detachFinal();
      this.teardownPromise = Promise.resolve();
      return this.teardownPromise;
    }
    this.teardownPromise = new Promise<void>((resolve) => {
      let killTimer: NodeJS.Timeout | undefined;
      let settled = false;
      const finish = () => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(termTimer);
        if (killTimer !== undefined) {
          clearTimeout(killTimer);
        }
        child.off("close", onClose);
        this.detachFinal();
        resolve();
      };
      const onClose = () => {
        finish();
      };
      child.once("close", onClose);
      const termTimer = setTimeout(() => {
        try {
          if (!this.hasExited()) {
            child.kill("SIGKILL");
          }
        } catch {
          // Reaped between the check and the kill; the close event resolves.
        }
        killTimer = setTimeout(finish, STOP_KILL_TIMEOUT_MS);
        killTimer.unref();
      }, STOP_TERM_TIMEOUT_MS);
      termTimer.unref();
      try {
        child.kill("SIGTERM");
      } catch {
        finish();
      }
    });
    return this.teardownPromise;
  }

  private detachFinal(): void {
    const child = this.child;
    if (child === null) {
      return;
    }
    try {
      child.stdin?.destroy();
    } catch {
      // Already destroyed.
    }
    try {
      child.stdout?.destroy();
    } catch {
      // Already destroyed.
    }
    try {
      child.stderr?.destroy();
    } catch {
      // Already destroyed.
    }
    child.stdout?.removeAllListeners();
    child.stderr?.removeAllListeners();
    child.stdin?.removeAllListeners();
    child.removeAllListeners("close");
    child.removeAllListeners("error");
  }
}
