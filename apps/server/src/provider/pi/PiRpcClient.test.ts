/**
 * PiRpcClient tests — focused fixture-subprocess coverage of the
 * `pi --mode rpc` JSONL transport.
 *
 * Every test spawns a throwaway fixture script (an executable Node program
 * that tolerates the exact `["--mode", "rpc", ...]` argv and speaks the
 * response/event framing from `docs/rpc.md`) instead of a real `pi` binary,
 * so no Pi config, credentials, or model access are involved. The client
 * under test receives a minimal environment (PATH plus one sentinel variable)
 * to prove the transport passes the supplied environment through untouched.
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
// Fixture stand-in for \`pi --mode rpc\`: tolerates any argv, reads JSONL on
// stdin, and answers a small set of test commands. Unknown types with an id
// get success:false; unknown types without an id are stored silently (the
// fire-and-forget path the client uses for extension_ui_response).
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
    // A failed command is not a transport failure: the client stays usable.
    const echoed = (await client.request("echo", { payload: "after" })) as { payload: unknown };
    expect(echoed).toEqual({ payload: "after" });
    expect(exits).toEqual([]);
  });

  it("reassembles split UTF-8 bytes with LF-only framing", async () => {
    const { client } = createClient();
    const data = (await client.request("chunked")) as { text: unknown };
    // The payload carries an emoji plus U+2028/U+2029: a reader splitting on
    // anything but LF would have broken the record apart.
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
    // The transport stays failed so no recycled operation can observe a late
    // response from the hung command.
    await expect(client.request("echo", { payload: "late" })).rejects.toThrow();
  });

  it("rejects pending work and notifies onExit when the process crashes", async () => {
    const { client, exits } = createClient();
    await expect(client.request("die")).rejects.toThrow(/exited.*fixture dying/);
    await waitFor(() => exits.length > 0);
    expect(exits).toHaveLength(1);
    expect(exits[0]?.message).toMatch(/exited.*fixture dying/);
  });

  it("fails the transport on malformed JSON", async () => {
    const { client, exits } = createClient();
    await expect(client.request("bad_json")).rejects.toThrow("invalid JSON");
    await waitFor(() => exits.length > 0);
    expect(exits).toHaveLength(1);
  });

  it("fails the transport on envelopes and responses that miss the schema", async () => {
    const first = createClient();
    await expect(first.client.request("bad_envelope")).rejects.toThrow("malformed envelope");
    await waitFor(() => first.exits.length > 0);

    const second = createClient();
    await expect(second.client.request("broken_response")).rejects.toThrow(/malformed response/);
    await waitFor(() => second.exits.length > 0);
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
