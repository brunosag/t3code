// @effect-diagnostics nodeBuiltinImport:off globalTimers:off preferSchemaOverJson:off -- Node fixture subprocess speaks raw JSONL with setTimeout polling; assertions use JSON directly.
/**
 * PiRpcClient tests — fixture-subprocess coverage of the `pi --mode rpc`
 * JSONL transport.
 */
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";

import { PiRpcClient } from "./PiRpcClient.ts";

const FIXTURE_SENTINEL = "t3-pi-rpc-sentinel";
const FIXTURE_SCRIPT_NAME = "pi-rpc-fixture";

// Exercises LF-only framing: U+2028/U+2029 must not split the record, and the
// emoji forces multi-byte UTF-8 sequences through the incremental decoder.
const CHUNKED_TEXT = "hello 🌍 rooftop U+2028:\u2028 U+2029:\u2029 end";

const FIXTURE_SCRIPT = `#!/usr/bin/env node
"use strict";
let buffer = "";
const received = [];
const writeLine = (text) => { process.stdout.write(text + "\\n"); };
const respondTo = (message, body) => {
  const response = { type: "response", command: message.type, ...body };
  if (message.id !== undefined) response.id = message.id;
  writeLine(JSON.stringify(response));
};
const writeChunked = (text) => {
  const bytes = Buffer.from(text, "utf8");
  let offset = 0;
  const step = () => {
    if (offset >= bytes.length) return;
    const end = Math.min(bytes.length, offset + 1);
    process.stdout.write(bytes.subarray(offset, end));
    offset = end;
    setImmediate(step);
  };
  step();
};
const handle = (message) => {
  received.push(message);
  switch (message.type) {
    case "get_argv":
      respondTo(message, { success: true, data: { argv: process.argv.slice(2) } });
      break;
    case "get_env":
      respondTo(message, {
        success: true,
        data: { sentinel: process.env.T3_PI_RPC_FIXTURE_SENTINEL ?? null },
      });
      break;
    case "echo":
      respondTo(message, { success: true, data: { payload: message.payload ?? null } });
      break;
    case "prompt":
      writeLine(JSON.stringify({ type: "message_update", marker: "prompt-event" }));
      respondTo(message, { success: true, data: { accepted: true } });
      break;
    case "fail_me":
      respondTo(message, { success: false, error: "boom" });
      break;
    case "hang":
      break;
    case "chunked": {
      const response = {
        type: "response", command: "chunked", success: true, data: { text: ${JSON.stringify(CHUNKED_TEXT)} },
      };
      if (message.id !== undefined) response.id = message.id;
      writeChunked(JSON.stringify(response) + "\\n");
      break;
    }
    case "crlf": {
      const response = { type: "response", command: "crlf", success: true, data: { ok: true } };
      if (message.id !== undefined) response.id = message.id;
      process.stdout.write(JSON.stringify(response) + "\\r\\n");
      break;
    }
    case "bad_json":
      process.stdout.write("this is not json\\n");
      break;
    case "bad_envelope":
      writeLine(JSON.stringify({ nope: true }));
      break;
    case "broken_response": {
      const response = { type: "response", command: "broken_response", data: {} };
      if (message.id !== undefined) response.id = message.id;
      writeLine(JSON.stringify(response));
      break;
    }
    case "die":
      process.stderr.write("fixture dying\\n");
      process.exit(1);
      break;
    case "burst": {
      const lines = [];
      for (let i = 0; i < 100; i += 1) {
        lines.push(JSON.stringify({ type: "burst_event", index: i, pad: "x".repeat(50 * 1024) }));
      }
      process.stdout.write(lines.join("\\n") + "\\n");
      respondTo(message, { success: true, data: { count: 100 } });
      break;
    }
    case "long_line":
      process.stdout.write("x".repeat(4 * 1024 * 1024 + 1) + "\\n");
      break;
    case "wrong_command": {
      const response = { type: "response", command: "other_command", success: true, data: {} };
      if (message.id !== undefined) response.id = message.id;
      writeLine(JSON.stringify(response));
      break;
    }
    case "echo_then_die": {
      respondTo(message, { success: true, data: { payload: message.payload ?? null } });
      setTimeout(() => {
        process.stderr.write("goodbye\\n");
        process.exit(1);
      }, 50);
      break;
    }
    case "close_stdout":
      process.stdout.end();
      break;
    case "die_signal":
      process.kill(process.pid, "SIGTERM");
      break;
    case "get_received":
      respondTo(message, {
        success: true,
        data: { received: received.filter((entry) => entry !== message) },
      });
      break;
    default:
      if (message.id !== undefined) {
        respondTo(message, { success: false, error: "unknown command: " + String(message.type) });
      }
      break;
  }
};
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index = buffer.indexOf("\\n");
  while (index !== -1) {
    let line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (line.endsWith("\\r")) line = line.slice(0, -1);
    if (line.length > 0) {
      try { handle(JSON.parse(line)); } catch { /* ignore */ }
    }
    index = buffer.indexOf("\\n");
  }
});
process.stdin.resume();
`;

interface ClientHarness {
  readonly client: PiRpcClient;
  readonly events: Record<string, unknown>[];
  readonly exits: Error[];
}

const openClients: PiRpcClient[] = [];
const fixtureDirectories: string[] = [];

function createClient(input?: {
  readonly sessionPath?: string;
  readonly requestTimeoutMs?: number;
}): ClientHarness {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-pi-rpc-"));
  fixtureDirectories.push(directory);
  const binaryPath = NodePath.join(directory, FIXTURE_SCRIPT_NAME);
  NodeFS.writeFileSync(binaryPath, FIXTURE_SCRIPT, { mode: 0o755 });
  const events: Record<string, unknown>[] = [];
  const exits: Error[] = [];
  const client = new PiRpcClient({
    binaryPath,
    cwd: directory,
    environment: {
      PATH: NodeProcess.env.PATH ?? "",
      T3_PI_RPC_FIXTURE_SENTINEL: FIXTURE_SENTINEL,
    },
    ...(input?.sessionPath !== undefined ? { sessionPath: input.sessionPath } : {}),
    ...(input?.requestTimeoutMs !== undefined ? { requestTimeoutMs: input.requestTimeoutMs } : {}),
    onEvent: (event) => {
      events.push(event);
    },
    onExit: (error) => {
      exits.push(error);
    },
  });
  openClients.push(client);
  return { client, events, exits };
}

function flattenCause(error: unknown): string {
  const seen: Array<unknown> = [error];
  let current: unknown = error;
  let text = "";
  while (current instanceof Error) {
    text += `\n${current.message}`;
    const cause: unknown = (current as { cause?: unknown }).cause;
    if (cause === undefined || cause === null || seen.includes(cause)) {
      break;
    }
    seen.push(cause);
    if (cause instanceof Error) {
      current = cause;
    } else {
      text += `\n${String(cause)}`;
      break;
    }
  }
  return text;
}

async function waitFor(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
  const start = NodeProcess.hrtime.bigint();
  while (!condition()) {
    const elapsedMs = Number(NodeProcess.hrtime.bigint() - start) / 1_000_000;
    if (elapsedMs > timeoutMs) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

afterEach(async () => {
  while (openClients.length > 0) {
    const client = openClients.pop();
    if (client !== undefined) {
      await client.close();
    }
  }
  while (fixtureDirectories.length > 0) {
    const directory = fixtureDirectories.pop();
    if (directory !== undefined) {
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  }
});

describe("PiRpcClient", () => {
  it("spawns the binary with exactly --mode rpc and resolves response data", async () => {
    const { client, events, exits } = createClient();
    const argv = (await client.request("get_argv")) as { argv: string[] };
    expect(argv.argv).toEqual(["--mode", "rpc"]);
    const echoed = (await client.request("echo", { payload: "ping" })) as { payload: unknown };
    expect(echoed).toEqual({ payload: "ping" });
    expect(events).toEqual([]);
    expect(exits).toEqual([]);
  });

  it("forwards sessionPath as --session and passes cwd/environment through", async () => {
    const { client } = createClient({ sessionPath: "/tmp/t3-pi-test-session.jsonl" });
    const argv = (await client.request("get_argv")) as { argv: string[] };
    expect(argv.argv).toEqual(["--mode", "rpc", "--session", "/tmp/t3-pi-test-session.jsonl"]);
    const env = (await client.request("get_env")) as { sentinel: unknown };
    expect(env).toEqual({ sentinel: FIXTURE_SENTINEL });
  });

  it("correlates concurrent requests and routes events to onEvent", async () => {
    const { client, events } = createClient();
    const [first, second, third] = await Promise.all([
      client.request("echo", { payload: "one" }),
      client.request("prompt", { message: "hi" }),
      client.request("echo", { payload: "three" }),
    ]);
    expect(first).toEqual({ payload: "one" });
    expect(second).toEqual({ accepted: true });
    expect(third).toEqual({ payload: "three" });
    expect(events).toEqual([{ type: "message_update", marker: "prompt-event" }]);
  });

  it("rejects when the response reports success:false", async () => {
    const { client, exits } = createClient();
    await expect(client.request("fail_me")).rejects.toThrow("boom");
    const echoed = (await client.request("echo", { payload: "after" })) as { payload: unknown };
    expect(echoed).toEqual({ payload: "after" });
    expect(exits).toEqual([]);
  });

  it("reassembles split UTF-8 bytes with LF-only framing", async () => {
    const { client } = createClient();
    const data = (await client.request("chunked")) as { text: unknown };
    expect(data).toEqual({ text: CHUNKED_TEXT });
  });

  it("accepts CRLF-terminated records", async () => {
    const { client } = createClient();
    await expect(client.request("crlf")).resolves.toEqual({ ok: true });
  });

  it("delivers fire-and-forget send() payloads without expecting a response", async () => {
    const { client } = createClient();
    client.send({ type: "extension_ui_response", id: "ui-1", value: "Allow" });
    const data = (await client.request("get_received")) as {
      received: Record<string, unknown>[];
    };
    expect(data.received).toContainEqual({
      type: "extension_ui_response",
      id: "ui-1",
      value: "Allow",
    });
  });

  it("rejects the pending request and fails the transport on timeout", async () => {
    const { client, exits } = createClient({ requestTimeoutMs: 200 });
    await expect(client.request("hang")).rejects.toThrow("timed out");
    await waitFor(() => exits.length > 0);
    expect(exits).toHaveLength(1);
    await expect(client.request("echo", { payload: "late" })).rejects.toThrow();
  });

  it("keeps stderr in the cause diagnostic, not the exit message", async () => {
    const { client, exits } = createClient();
    const failure = await client.request("die").then(
      () => {
        throw new Error("expected die to reject");
      },
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/exited unexpectedly/);
    expect((failure as Error).message).not.toContain("fixture dying");
    await waitFor(() => exits.length > 0);
    expect(exits).toHaveLength(1);
    expect(exits[0]?.message).toMatch(/exited unexpectedly/);
    expect(exits[0]?.message).not.toContain("fixture dying");
    expect(flattenCause(exits[0])).toContain("fixture dying");
  });

  it("fails the transport on malformed JSON without leaking the raw payload", async () => {
    const { client, exits } = createClient();
    await expect(client.request("bad_json")).rejects.toThrow("invalid JSON");
    await waitFor(() => exits.length > 0);
    expect(exits).toHaveLength(1);
    expect(exits[0]?.message).toBe("pi rpc: invalid JSON from process");
    expect(exits[0]?.message).not.toContain("this is not json");
  });

  it("fails the transport on envelopes and responses that miss the schema", async () => {
    const first = createClient();
    await expect(first.client.request("bad_envelope")).rejects.toThrow("malformed envelope");
    await waitFor(() => first.exits.length > 0);

    const second = createClient();
    await expect(second.client.request("broken_response")).rejects.toThrow(/malformed response/);
    await waitFor(() => second.exits.length > 0);
  });

  it("fails when a correlated response carries a mismatched command", async () => {
    const { client, exits } = createClient();
    await expect(client.request("wrong_command")).rejects.toThrow(/mismatched response command/);
    await waitFor(() => exits.length > 0);
    expect(exits).toHaveLength(1);
    expect(exits[0]?.message).toMatch(/mismatched response command/);
    await expect(client.request("echo", { payload: "late" })).rejects.toThrow();
  });

  it("accepts many short frames in one chunk without tripping the line limit", async () => {
    const { client, events, exits } = createClient();
    const data = (await client.request("burst")) as { count: unknown };
    expect(data).toEqual({ count: 100 });
    expect(events.filter((event) => event["type"] === "burst_event")).toHaveLength(100);
    expect(exits).toEqual([]);
  });

  it("fails a single over-long line", async () => {
    const { client, exits } = createClient();
    await expect(client.request("long_line")).rejects.toThrow(/exceeds/);
    await waitFor(() => exits.length > 0);
    expect(exits).toHaveLength(1);
  });

  it("delivers final stdout before an unexpected close", async () => {
    const { client, exits } = createClient();
    await expect(client.request("echo_then_die", { payload: "final" })).resolves.toEqual({
      payload: "final",
    });
    await waitFor(() => exits.length > 0);
    expect(exits).toHaveLength(1);
    expect(exits[0]?.message).toMatch(/exited unexpectedly/);
  });

  it("fails when stdout closes while the child stays alive", async () => {
    const { client, exits } = createClient();
    await expect(client.request("close_stdout")).rejects.toThrow(/stdout closed/);
    await waitFor(() => exits.length > 0);
    expect(exits).toHaveLength(1);
    expect(exits[0]?.message).toMatch(/stdout closed/);
  });

  it("reports signal exits and lets close() await the shared teardown", async () => {
    const { client, exits } = createClient();
    await expect(client.request("die_signal")).rejects.toThrow(/exited unexpectedly/);
    await waitFor(() => exits.length > 0);
    expect(exits[0]?.message).toMatch(/SIGTERM/);
    await expect(client.close()).resolves.toBeUndefined();
    expect(exits).toHaveLength(1);
  });

  it("shares close teardown after a failure without a second onExit", async () => {
    const { client, exits } = createClient();
    await expect(client.request("bad_json")).rejects.toThrow("invalid JSON");
    await waitFor(() => exits.length > 0);
    await expect(client.close()).resolves.toBeUndefined();
    await expect(client.close()).resolves.toBeUndefined();
    expect(exits).toHaveLength(1);
  });

  it("close() stops the process and rejects later work without onExit", async () => {
    const { client, exits } = createClient();
    await expect(client.request("echo", { payload: "alive" })).resolves.toEqual({
      payload: "alive",
    });
    await client.close();
    await client.close();
    await expect(client.request("echo", { payload: "after" })).rejects.toThrow("closed");
    expect(() => {
      client.send({ type: "extension_ui_response", id: "ui-2" });
    }).toThrow("closed");
    expect(exits).toEqual([]);
  });

  it("handles spawn errors without throwing from the constructor", async () => {
    const exits: Error[] = [];
    let client: PiRpcClient | undefined;
    expect(() => {
      client = new PiRpcClient({
        binaryPath: NodePath.join(NodeOS.tmpdir(), "t3-pi-rpc-missing-binary"),
        cwd: NodeOS.tmpdir(),
        environment: { PATH: NodeProcess.env.PATH ?? "" },
        onEvent: () => {},
        onExit: (error) => {
          exits.push(error);
        },
      });
    }).not.toThrow();
    if (client !== undefined) {
      openClients.push(client);
      await expect(client.request("echo")).rejects.toThrow();
      await waitFor(() => exits.length > 0);
      expect(exits).toHaveLength(1);
    }
  });
});
