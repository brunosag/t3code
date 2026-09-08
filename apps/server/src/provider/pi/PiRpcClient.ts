/**
 * PiRpcClient — subprocess JSONL transport for `pi --mode rpc`.
 *
 * This module is both the adapter and the driver for the Pi provider's RPC
 * transport: it spawns the `pi` binary, frames strict JSONL records on
 * stdin/stdout, correlates `request()` calls with `response` envelopes by id,
 * and surfaces every other envelope (agent events, `extension_ui_request`
 * turns, `bash_execution_update` chunks) to `onEvent`.
 *
 * Deliberately dependency-free: it speaks the external `pi --mode rpc`
 * protocol without importing the Pi package, reading Pi config files, or
 * overriding the environment. The caller supplies `binaryPath`, `cwd`, and
 * the full `environment`; the child is spawned with exactly
 * `["--mode", "rpc"]` plus `["--session", sessionPath]` when a session path
 * is given — no provider/model inference, no extra flags.
 *
 * Framing follows the strict JSONL contract: LF (`\n`) is the only record
 * delimiter (a trailing `\r` is tolerated for `\r\n` writers), UTF-8 decoding
 * is incremental so multi-byte characters split across `data` events survive,
 * and Node `readline` is never used because it also splits on U+2028/U+2029,
 * which are legal inside JSON strings.
 *
 * Failure policy: any transport error (spawn failure, unexpected exit,
 * malformed JSON, an envelope without a string `type`, an over-long line, a
 * write failure) rejects every pending request and notifies `onExit` exactly
 * once. A request that exceeds `requestTimeoutMs` rejects and fails the whole
 * transport, so a late response can never resolve a recycled operation.
 * `close()` stops the child with SIGTERM, escalates to SIGKILL after a
 * bounded wait, and only ever signals the child it spawned — never by name
 * or pattern. `onExit` is for unexpected failures; intentional `close()` does
 * not report through it.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeStringDecoder from "node:string_decoder";

/** Options for {@link PiRpcClient}. */
export interface PiRpcClientOptions {
  /** Absolute path (or PATH-resolvable name) of the `pi` binary to spawn. */
  readonly binaryPath: string;
  /** Working directory the child process runs in. */
  readonly cwd: string;
  /**
   * Complete environment for the child, passed through as-is. The client
   * never merges `process.env` or reads Pi config — the caller owns the
   * environment it hands in.
   */
  readonly environment: NodeJS.ProcessEnv;
  /** Optional session file, forwarded as `--session <path>` and nothing else. */
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
/** Retained stderr tail attached to exit errors. */
const MAX_STDERR_CHARS = 64 * 1024;
/** Wait after SIGTERM before escalating to SIGKILL. */
const STOP_TERM_TIMEOUT_MS = 2_000;
/** Bounded wait after SIGKILL before `close()` gives up waiting. */
const STOP_KILL_TIMEOUT_MS = 2_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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
  private closePromise: Promise<void> | null = null;
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
      // Synchronous spawn failure (bad binary path, bad cwd): mark the
      // transport failed now and report asynchronously so the constructor
      // itself never throws for spawn errors and the host always observes
      // exactly one onExit.
      const failure = new Error(
        `pi rpc: failed to spawn "${options.binaryPath}": ${toError(error, "unknown spawn error").message}`,
      );
      this.child = null;
      this.failed = failure;
      queueMicrotask(() => {
        this.notifyExit(failure);
      });
      return;
    }
    this.child = child;
    // Lifecycle listeners attach synchronously in the constructor, before any
    // request can be written — there is no handshake to race with.
    child.on("error", (error) => {
      if (this.closing) return;
      this.failTransport(
        new Error(
          `pi rpc: process error for "${this.binaryPath}": ${error.message}. Stderr: ${this.stderrTail}`,
        ),
      );
    });
    child.on("exit", (code, signal) => {
      if (this.closing) return;
      this.failTransport(this.exitError(code, signal));
    });
    child.stdout?.on("data", (chunk: Buffer | string) => {
      this.handleStdoutData(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      this.stderrTail = `${this.stderrTail}${text}`.slice(-MAX_STDERR_CHARS);
    });
    child.stdin?.on("error", (error) => {
      if (this.closing) return;
      this.failTransport(
        new Error(`pi rpc: process stdin error for "${this.binaryPath}": ${error.message}`),
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
        // A late response must never resolve a recycled operation, so the
        // timeout takes the whole transport down with it.
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
   * Stop the child (SIGTERM, then bounded SIGKILL of only the spawned
   * process) and resolve once it exits. Idempotent; never reports via
   * `onExit`.
   */
  close(): Promise<void> {
    if (this.closePromise !== null) {
      return this.closePromise;
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
    this.closePromise = this.stopChild();
    return this.closePromise;
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
      line = `${JSON.stringify(message)}\n`;
    } catch (error) {
      this.failTransport(
        new Error(
          `pi rpc: failed to serialize message: ${toError(error, "unknown error").message}`,
        ),
      );
      return;
    }
    try {
      child.stdin.write(line, "utf8");
    } catch (error) {
      this.failTransport(
        new Error(`pi rpc: failed to write message: ${toError(error, "unknown error").message}`),
      );
    }
  }

  private handleStdoutData(chunk: Buffer | string): void {
    if (this.failed !== null || this.child === null) {
      return;
    }
    this.stdoutBuffer += typeof chunk === "string" ? chunk : this.decoder.write(chunk);
    if (this.stdoutBuffer.length > MAX_LINE_CHARS) {
      this.failTransport(
        new Error(`pi rpc: stdout line exceeds ${MAX_LINE_CHARS} characters, failing transport`),
      );
      return;
    }
    let newlineIndex = this.stdoutBuffer.indexOf("\n");
    while (newlineIndex !== -1) {
      let line = this.stdoutBuffer.slice(0, newlineIndex);
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      if (line.endsWith("\r")) {
        line = line.slice(0, -1);
      }
      if (line.length > 0) {
        this.handleLine(line);
        if (this.failed !== null) {
          return;
        }
      }
      newlineIndex = this.stdoutBuffer.indexOf("\n");
    }
  }

  private handleLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.failTransport(new Error(`pi rpc: invalid JSON from process: ${line.slice(0, 200)}`));
      return;
    }
    if (!isRecord(parsed) || typeof parsed.type !== "string") {
      this.failTransport(new Error("pi rpc: malformed envelope without a string type"));
      return;
    }
    if (parsed.type === "response") {
      this.handleResponse(parsed);
      return;
    }
    try {
      this.onEventCallback(parsed);
    } catch (error) {
      this.failTransport(
        new Error(`pi rpc: onEvent threw: ${toError(error, "unknown error").message}`),
      );
    }
  }

  private handleResponse(envelope: Record<string, unknown>): void {
    const id = envelope.id;
    if (typeof id !== "string" && typeof id !== "number") {
      // No correlation id — nothing can be resolved; ignore rather than fail
      // so unsolicited responses cannot take the transport down.
      return;
    }
    const pending = this.pending.get(String(id));
    if (pending === undefined) {
      // Unknown or already-settled id (e.g. a late arrival after a timeout):
      // ignore to prevent zombie operations from resolving the wrong caller.
      return;
    }
    this.pending.delete(String(id));
    clearTimeout(pending.timer);
    if (envelope.success === true) {
      pending.resolve(envelope.data);
      return;
    }
    if (envelope.success === false) {
      const command = typeof envelope.command === "string" ? envelope.command : pending.command;
      const detail =
        typeof envelope.error === "string" && envelope.error.length > 0
          ? envelope.error
          : `command "${command}" failed`;
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
    const tail = this.stderrTail.length > 0 ? `. Stderr: ${this.stderrTail}` : "";
    return new Error(
      `pi rpc: process "${this.binaryPath}" exited (code=${code} signal=${signal})${tail}`,
    );
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
    this.destroyChild();
    this.detachChild();
    this.notifyExit(error);
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

  /** SIGTERM now, bounded SIGKILL escalation, only the spawned child. */
  private destroyChild(): void {
    const child = this.child;
    if (child === null || child.exitCode !== null) {
      return;
    }
    try {
      child.kill("SIGTERM");
    } catch {
      // Already reaped; its exit event (or lack of process) settles the rest.
      return;
    }
    const killTimer = setTimeout(() => {
      try {
        if (child.exitCode === null) {
          child.kill("SIGKILL");
        }
      } catch {
        // Reaped between the check and the kill.
      }
    }, STOP_TERM_TIMEOUT_MS);
    killTimer.unref();
  }

  private detachChild(): void {
    const child = this.child;
    if (child === null) {
      return;
    }
    child.stdout?.removeAllListeners("data");
    child.stderr?.removeAllListeners("data");
    child.stdin?.removeAllListeners("error");
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
  }

  private stopChild(): Promise<void> {
    const child = this.child;
    if (child === null || child.exitCode !== null) {
      this.detachChild();
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
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
        child.off("exit", onExit);
        this.detachChild();
        resolve();
      };
      const onExit = () => {
        finish();
      };
      child.once("exit", onExit);
      const termTimer = setTimeout(() => {
        try {
          if (child.exitCode === null) {
            child.kill("SIGKILL");
          }
        } catch {
          // Reaped between the check and the kill; the exit event resolves.
        }
        killTimer = setTimeout(finish, STOP_KILL_TIMEOUT_MS);
        killTimer.unref();
      }, STOP_TERM_TIMEOUT_MS);
      termTimer.unref();
      try {
        child.kill("SIGTERM");
      } catch {
        // Already gone; resolve without waiting for an exit event.
        finish();
      }
    });
  }
}
