// @effect-diagnostics nodeBuiltinImport:off
/**
 * PiAdapter tests — public-behavior coverage of `makePiAdapter` through the
 * injectable `createClient` seam. The fake below speaks the documented
 * `pi --mode rpc` protocol (see the installed `rpc.md`: `prompt` accepts
 * `streamingBehavior: "steer"`, `clear_queue` precedes `abort`, `agent_end`
 * is not settlement while `agent_settled` is, extension dialogs round-trip
 * via `extension_ui_response`).
 *
 * No sleeps: the fake is synchronously controlled and every async wait is a
 * Stream receipt joined through a forked fiber.
 */
import { describe, expect, it } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import {
  ApprovalRequestId,
  ProviderInstanceId,
  ProviderRuntimeEvent,
  ThreadId,
  type ProviderSessionStartInput,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { makePiAdapter } from "./PiAdapter.ts";
import type { PiRpcClient } from "./PiRpcClient.ts";

type PiAdapter = Effect.Success<ReturnType<typeof makePiAdapter>>;
type ClientInit = ConstructorParameters<typeof PiRpcClient>[0];
type Client = Pick<PiRpcClient, "request" | "send" | "close">;

interface RecordedRequest {
  readonly type: string;
  readonly fields: Record<string, unknown> | undefined;
}

/** Synchronously controlled fake for the `pi --mode rpc` transport. */
class FakePiClient implements Client {
  readonly requests: Array<RecordedRequest> = [];
  readonly sends: Array<Record<string, unknown>> = [];
  closed = false;
  state: Record<string, unknown> = {
    sessionFile: "/tmp/t3-pi-adapter-session.jsonl",
    sessionId: "pi-session-1",
    model: null,
    isStreaming: false,
  };
  private readonly failures = new Map<string, Error>();

  private readonly init: ClientInit;

  constructor(init: ClientInit) {
    this.init = init;
  }

  failRequest(type: string, message: string): void {
    this.failures.set(type, new Error(message));
  }

  clearFailure(type: string): void {
    this.failures.delete(type);
  }

  request(type: string, fields: Record<string, unknown> = {}): Promise<unknown> {
    this.requests.push({ type, fields });
    const failure = this.failures.get(type);
    if (failure !== undefined) return Promise.reject(failure);
    switch (type) {
      case "get_state":
        return Promise.resolve({ ...this.state });
      case "set_model":
      case "prompt":
      case "clear_queue":
      case "abort":
      case "compact":
        return Promise.resolve({});
      default:
        return Promise.reject(new Error(`unexpected Pi RPC request: ${type}`));
    }
  }

  send(message: Record<string, unknown>): void {
    this.sends.push(message);
  }

  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }

  emit(event: Record<string, unknown>): void {
    this.init.onEvent(event);
  }

  crash(error: Error): void {
    this.init.onExit(error);
  }

  requestTypes(): Array<string> {
    return this.requests.map((request) => request.type);
  }
}

interface Harness {
  readonly inits: Array<ClientInit>;
  readonly clients: Array<FakePiClient>;
  readonly environment: NodeJS.ProcessEnv;
  readonly options: Parameters<typeof makePiAdapter>[0];
  initialState: Record<string, unknown>;
}

const piInstance = ProviderInstanceId.make("pi-test");

function makeHarness(): Harness {
  const inits: Array<ClientInit> = [];
  const clients: Array<FakePiClient> = [];
  const environment: NodeJS.ProcessEnv = { PATH: "/bin", T3_PI_ADAPTER_TEST: "1" };
  const harness: Harness = {
    inits,
    clients,
    environment,
    options: {
      binaryPath: "/bin/pi",
      environment,
      cwd: "/default-cwd",
      attachmentsDir: "/attachments",
      instanceId: piInstance,
      createClient: (init) => {
        inits.push(init);
        const client = new FakePiClient(init);
        client.state = { ...harness.initialState };
        clients.push(client);
        return client;
      },
    },
    initialState: {
      sessionFile: "/tmp/t3-pi-adapter-session.jsonl",
      sessionId: "pi-session-1",
      model: null,
      isStreaming: false,
    },
  };
  return harness;
}

function startSession(
  adapter: PiAdapter,
  threadId: ThreadId,
  extra: Pick<ProviderSessionStartInput, "cwd" | "modelSelection"> & {
    readonly resumeCursor?: unknown;
  } = {},
) {
  return adapter.startSession({ threadId, runtimeMode: "full-access", ...extra });
}

function subscribe(adapter: PiAdapter, count: number) {
  return Effect.gen(function* () {
    const fiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, count)).pipe(
      Effect.forkChild,
    );
    // The adapter publishes synchronously, so let the forked subscriber
    // register with the PubSub before the test drives any events.
    yield* Effect.yieldNow;
    yield* Effect.yieldNow;
    yield* Effect.yieldNow;
    return fiber;
  });
}

const assertRuntimeEvent = Schema.decodeUnknownSync(ProviderRuntimeEvent);

describe("PiAdapter", () => {
  it.effect("reuses a live session and passes cwd/environment through unchanged", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const adapter = yield* makePiAdapter(harness.options);
      const threadId = ThreadId.make("thread-reuse");
      const receipts = yield* subscribe(adapter, 2);

      const first = yield* startSession(adapter, threadId, { cwd: "/custom-cwd" });
      const second = yield* startSession(adapter, threadId, { cwd: "/custom-cwd" });

      expect(second).toEqual(first);
      expect(harness.clients).toHaveLength(1);
      expect(harness.inits[0]?.cwd).toBe("/custom-cwd");
      expect(harness.inits[0]?.binaryPath).toBe("/bin/pi");
      expect(harness.inits[0]?.environment).toBe(harness.environment);
      expect(harness.inits[0]?.sessionPath).toBeUndefined();
      expect(first.cwd).toBe("/custom-cwd");

      const events = Array.from(yield* Fiber.join(receipts));
      expect(events.map((event) => event.type)).toEqual([
        "session.started",
        "session.state.changed",
      ]);
      expect(yield* adapter.hasSession(threadId)).toBe(true);
      expect(yield* adapter.listSessions()).toHaveLength(1);
    }),
  );

  it.effect("keeps other subscribers and sessions alive across disconnect and stop", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const adapter = yield* makePiAdapter(harness.options);
      const threadA = ThreadId.make("thread-a");
      const threadB = ThreadId.make("thread-b");
      yield* startSession(adapter, threadA);
      yield* startSession(adapter, threadB);

      const survivor = yield* subscribe(adapter, 2);
      const dropped = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);
      // Interrupt waits for the dropped subscriber's teardown.
      yield* Fiber.interrupt(dropped);

      yield* adapter.stopSession(threadA);
      harness.clients[1]?.emit({
        type: "message_start",
        message: { role: "assistant", content: [{ type: "text", text: "" }] },
      });

      const events = Array.from(yield* Fiber.join(survivor));
      expect(events.map((event) => event.type)).toEqual(["session.exited", "item.started"]);
      expect(events[0]).toMatchObject({
        type: "session.exited",
        threadId: threadA,
      });
      expect(harness.clients[0]?.closed).toBe(true);
      expect(harness.clients[1]?.closed).toBe(false);
      expect(yield* adapter.hasSession(threadA)).toBe(false);
      expect(yield* adapter.hasSession(threadB)).toBe(true);
      // The surviving session still accepts turns after the disconnect and stop.
      const result = yield* adapter.sendTurn({ threadId: threadB, input: "still here" });
      expect(result.threadId).toBe(threadB);

      yield* adapter.stopAll();
      expect(harness.clients.every((client) => client.closed)).toBe(true);
      expect(yield* adapter.listSessions()).toHaveLength(0);
    }),
  );

  it.effect("forwards opaque resume cursors and rejects missing or mismatched resume state", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const adapter = yield* makePiAdapter(harness.options);
      const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-pi-adapter-"));
      try {
        const sessionPath = NodePath.join(directory, "session.jsonl");
        NodeFS.writeFileSync(sessionPath, "");
        const cursor = { version: 1, sessionPath };
        // Seed the fake state so the resumed file matches.
        harness.initialState = { ...harness.initialState, sessionFile: sessionPath };
        const receipts = yield* subscribe(adapter, 2);
        const resumed = yield* startSession(adapter, ThreadId.make("thread-resume"), {
          resumeCursor: cursor,
        });
        expect(harness.inits[0]?.sessionPath).toBe(sessionPath);
        expect(resumed.resumeCursor).toEqual(cursor);
        expect(Array.from(yield* Fiber.join(receipts)).map((event) => event.type)).toEqual([
          "session.started",
          "session.state.changed",
        ]);

        const missing = yield* Effect.flip(
          startSession(adapter, ThreadId.make("thread-resume-missing"), {
            resumeCursor: { version: 1, sessionPath: NodePath.join(directory, "absent.jsonl") },
          }),
        );
        expect(missing._tag).toBe("ProviderAdapterRequestError");
        expect(missing.method).toBe("startSession");

        const relative = yield* Effect.flip(
          startSession(adapter, ThreadId.make("thread-resume-relative"), {
            resumeCursor: { version: 1, sessionPath: "relative/session.jsonl" },
          }),
        );
        expect(relative._tag).toBe("ProviderAdapterRequestError");
        expect(String(relative.detail)).toContain("absolute");

        harness.initialState = {
          ...harness.initialState,
          sessionFile: NodePath.join(directory, "other.jsonl"),
        };
        const mismatched = yield* Effect.flip(
          startSession(adapter, ThreadId.make("thread-resume-mismatch"), {
            resumeCursor: cursor,
          }),
        );
        expect(String(mismatched.detail)).toContain("different session");
      } finally {
        NodeFS.rmSync(directory, { recursive: true, force: true });
      }
    }),
  );

  it.effect("skips set_model for default, splits provider/modelId, rejects malformed models", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const adapter = yield* makePiAdapter(harness.options);

      yield* startSession(adapter, ThreadId.make("thread-default"), {
        modelSelection: createModelSelection(piInstance, "default"),
      });
      expect(harness.clients[0]?.requestTypes()).not.toContain("set_model");
      expect((yield* adapter.listSessions())[0]?.model).toBe("default");

      yield* startSession(adapter, ThreadId.make("thread-model"), {
        modelSelection: createModelSelection(piInstance, "acme/text-pro/v2"),
      });
      const setModel = harness.clients[1]?.requests.find((request) => request.type === "set_model");
      expect(setModel?.fields).toEqual({ provider: "acme", modelId: "text-pro/v2" });

      const malformed = yield* Effect.flip(
        startSession(adapter, ThreadId.make("thread-malformed"), {
          modelSelection: createModelSelection(piInstance, "justamodel"),
        }),
      );
      expect(malformed._tag).toBe("ProviderAdapterRequestError");
      expect(String(malformed.detail)).toContain("provider/modelId");
    }),
  );

  it.effect(
    "restores the initial Pi model after an explicit override, including after resume",
    () =>
      Effect.gen(function* () {
        const harness = makeHarness();
        const adapter = yield* makePiAdapter(harness.options);
        const threadId = ThreadId.make("default-restore");
        const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-pi-default-"));
        try {
          const sessionPath = NodePath.join(directory, "session.jsonl");
          NodeFS.writeFileSync(sessionPath, "");
          harness.initialState = {
            ...harness.initialState,
            sessionFile: sessionPath,
            model: { provider: "native", id: "original/model" },
          };
          yield* startSession(adapter, threadId, {
            modelSelection: createModelSelection(piInstance, "acme/override"),
          });
          const result = yield* adapter.sendTurn({
            threadId,
            input: "hello",
            modelSelection: createModelSelection(piInstance, "default"),
          });
          expect(
            harness.clients[0]!.requests.filter((r) => r.type === "set_model").map((r) => r.fields),
          ).toEqual([
            { provider: "acme", modelId: "override" },
            { provider: "native", modelId: "original/model" },
          ]);
          expect((yield* adapter.listSessions())[0]?.model).toBe("default");
          yield* adapter.stopSession(threadId);
          // A resumed Pi session can report the last explicit model. The saved baseline wins.
          harness.initialState = {
            ...harness.initialState,
            model: { provider: "acme", id: "override" },
          };
          yield* startSession(adapter, threadId, {
            resumeCursor: result.resumeCursor,
            modelSelection: createModelSelection(piInstance, "default"),
          });
          expect(harness.clients[1]!.requests.find((r) => r.type === "set_model")?.fields).toEqual({
            provider: "native",
            modelId: "original/model",
          });
        } finally {
          NodeFS.rmSync(directory, { recursive: true, force: true });
        }
      }),
  );

  it.effect(
    "fails default restoration without an initial model instead of accepting a mislabeled turn",
    () =>
      Effect.gen(function* () {
        const harness = makeHarness();
        const adapter = yield* makePiAdapter(harness.options);
        const threadId = ThreadId.make("missing-default");
        yield* startSession(adapter, threadId, {
          modelSelection: createModelSelection(piInstance, "acme/override"),
        });
        const error = yield* Effect.flip(
          adapter.sendTurn({
            threadId,
            input: "hello",
            modelSelection: createModelSelection(piInstance, "default"),
          }),
        );
        expect(error.detail).toContain("cannot restore Pi default");
        expect(harness.clients[0]!.requestTypes()).not.toContain("prompt");
        expect((yield* adapter.listSessions())[0]?.model).toBe("acme/override");
      }),
  );

  it.effect("switches models mid-session through sendTurn", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const adapter = yield* makePiAdapter(harness.options);
      const threadId = ThreadId.make("thread-switch");
      yield* startSession(adapter, threadId, {
        modelSelection: createModelSelection(piInstance, "acme/model-a"),
      });
      expect(harness.clients[0]?.requestTypes()).toEqual(["get_state", "set_model"]);

      yield* adapter.sendTurn({
        threadId,
        input: "hello",
        modelSelection: createModelSelection(piInstance, "acme/model-b"),
      });
      const setModels = harness.clients[0]?.requests.filter(
        (request) => request.type === "set_model",
      );
      expect(setModels?.at(-1)?.fields).toEqual({ provider: "acme", modelId: "model-b" });
      expect((yield* adapter.listSessions())[0]?.model).toBe("acme/model-b");

      const before = harness.clients[0]?.requests.length;
      yield* adapter.sendTurn({
        threadId,
        input: "again",
        modelSelection: createModelSelection(piInstance, "acme/model-b"),
      });
      expect(harness.clients[0]?.requests.length).toBe((before ?? 0) + 2);
    }),
  );

  it.effect("streams text/thinking/tool events as schema-valid canonical events", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const adapter = yield* makePiAdapter(harness.options);
      const threadId = ThreadId.make("thread-stream");
      yield* startSession(adapter, threadId);
      const receipts = yield* subscribe(adapter, 7);

      const client = harness.clients[0]!;
      client.emit({
        type: "message_start",
        message: { role: "assistant", content: [{ type: "text", text: "" }] },
      });
      client.emit({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hello " },
      });
      client.emit({
        type: "message_update",
        assistantMessageEvent: { type: "thinking_delta", contentIndex: 1, delta: "hmm" },
      });
      client.emit({
        type: "tool_execution_start",
        toolCallId: "call_1",
        toolName: "bash",
        args: { command: "ls" },
      });
      client.emit({
        type: "tool_execution_update",
        toolCallId: "call_1",
        toolName: "bash",
        args: { command: "ls" },
        partialResult: { content: [{ type: "text", text: "partial" }] },
      });
      client.emit({
        type: "tool_execution_end",
        toolCallId: "call_1",
        toolName: "bash",
        args: { command: "ls" },
        result: { content: [{ type: "text", text: "done" }] },
        isError: false,
      });
      client.emit({
        type: "message_end",
        message: { role: "assistant", content: "Hello ", stopReason: "stop" },
      });

      const events = Array.from(yield* Fiber.join(receipts));
      expect(events.map((event) => event.type)).toEqual([
        "item.started",
        "content.delta",
        "content.delta",
        "item.started",
        "item.updated",
        "item.completed",
        "item.completed",
      ]);
      for (const event of events) {
        expect(() => assertRuntimeEvent(event)).not.toThrow();
      }
      expect(events[1]).toMatchObject({
        type: "content.delta",
        payload: { streamKind: "assistant_text", delta: "Hello " },
      });
      expect(events[2]).toMatchObject({
        type: "content.delta",
        payload: { streamKind: "reasoning_text", delta: "hmm" },
      });
      expect(events[3]).toMatchObject({
        type: "item.started",
        payload: { itemType: "dynamic_tool_call", title: "bash", status: "inProgress" },
      });
      expect(events[5]).toMatchObject({
        type: "item.completed",
        payload: { itemType: "dynamic_tool_call", status: "completed" },
      });
      expect(events[6]).toMatchObject({
        type: "item.completed",
        payload: { itemType: "assistant_message", detail: "Hello " },
      });
    }),
  );

  it.effect("agent_end does not settle a retry/compaction run but agent_settled does", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const adapter = yield* makePiAdapter(harness.options);
      const threadId = ThreadId.make("thread-settle");
      yield* startSession(adapter, threadId);
      harness.clients[0]!.state = { ...harness.clients[0]!.state, isStreaming: true };
      const receipts = yield* subscribe(adapter, 6);

      const first = yield* adapter.sendTurn({ threadId, input: "hello" });
      // A low-level run completion must leave the turn open for retry/compaction.
      harness.clients[0]?.emit({ type: "agent_end", messages: [], willRetry: true });
      const steered = yield* adapter.sendTurn({ threadId, input: "keep going" });
      expect(steered.turnId).toBe(first.turnId);
      expect(harness.clients[0]?.requests.at(-2)).toMatchObject({
        type: "prompt",
        fields: { streamingBehavior: "steer" },
      });

      harness.clients[0]?.emit({ type: "auto_retry_start", errorMessage: "overloaded" });
      harness.clients[0]?.emit({ type: "compaction_end", result: { summary: "compacted" } });
      harness.clients[0]?.emit({ type: "agent_settled" });

      const events = Array.from(yield* Fiber.join(receipts));
      expect(events.map((event) => event.type)).toEqual([
        "turn.started",
        "session.state.changed",
        "runtime.warning",
        "thread.state.changed",
        "turn.completed",
        "session.state.changed",
      ]);
      expect(events[2]).toMatchObject({
        type: "runtime.warning",
        payload: { message: "overloaded" },
      });
      expect(events[3]).toMatchObject({
        type: "thread.state.changed",
        payload: { state: "compacted" },
      });
      expect(events[4]).toMatchObject({
        type: "turn.completed",
        payload: { state: "completed" },
      });
      // Settlement closed the turn, so the next turn starts fresh.
      const next = yield* adapter.sendTurn({ threadId, input: "after settle" });
      expect(next.turnId).not.toBe(first.turnId);
    }),
  );

  it.effect("steers within the same turn while the agent is running", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const adapter = yield* makePiAdapter(harness.options);
      const threadId = ThreadId.make("thread-steer");
      yield* startSession(adapter, threadId);
      harness.clients[0]!.state = { ...harness.clients[0]!.state, isStreaming: true };
      const receipts = yield* subscribe(adapter, 2);

      const first = yield* adapter.sendTurn({ threadId, input: "hello" });
      const second = yield* adapter.sendTurn({ threadId, input: "actually, stop" });

      expect(second.turnId).toBe(first.turnId);
      expect(second.resumeCursor).toEqual(first.resumeCursor);
      const prompts = harness.clients[0]?.requests.filter((request) => request.type === "prompt");
      expect(prompts).toHaveLength(2);
      expect(prompts?.[0]?.fields).not.toHaveProperty("streamingBehavior");
      expect(prompts?.[1]?.fields).toMatchObject({ streamingBehavior: "steer" });
      expect(Array.from(yield* Fiber.join(receipts)).map((event) => event.type)).toEqual([
        "turn.started",
        "session.state.changed",
      ]);
    }),
  );

  it.effect("interrupts with clear_queue before abort and resolves pending input", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const adapter = yield* makePiAdapter(harness.options);
      const threadId = ThreadId.make("thread-interrupt");
      yield* startSession(adapter, threadId);
      harness.clients[0]!.state = { ...harness.clients[0]!.state, isStreaming: true };
      const first = yield* adapter.sendTurn({ threadId, input: "hello" });
      const receipts = yield* subscribe(adapter, 4);

      harness.clients[0]?.emit({
        type: "extension_ui_request",
        id: "pending-1",
        method: "select",
        title: "Pick",
        options: ["Allow", "Block"],
      });
      yield* adapter.interruptTurn(threadId, first.turnId);

      const client = harness.clients[0]!;
      expect(client.requestTypes().slice(-2)).toEqual(["clear_queue", "abort"]);
      expect(client.sends).toContainEqual({
        type: "extension_ui_response",
        id: "pending-1",
        cancelled: true,
      });
      const events = Array.from(yield* Fiber.join(receipts));
      expect(events.map((event) => event.type)).toEqual([
        "user-input.requested",
        "user-input.resolved",
        "turn.completed",
        "session.state.changed",
      ]);
      expect(events[2]).toMatchObject({
        type: "turn.completed",
        payload: { state: "interrupted" },
      });

      const before = client.requests.length;
      yield* adapter.interruptTurn(threadId, first.turnId);
      expect(client.requests.length).toBe(before);
    }),
  );

  it.effect("round-trips extension select/confirm/input through user input", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const adapter = yield* makePiAdapter(harness.options);
      const threadId = ThreadId.make("thread-ui");
      yield* startSession(adapter, threadId);
      const receipts = yield* subscribe(adapter, 7);

      const client = harness.clients[0]!;
      client.emit({
        type: "extension_ui_request",
        id: "q-select",
        method: "select",
        title: "Pick one",
        options: ["Allow", "Block"],
      });
      client.emit({
        type: "extension_ui_request",
        id: "q-confirm",
        method: "confirm",
        title: "Sure?",
        message: "All will be lost.",
      });
      client.emit({
        type: "extension_ui_request",
        id: "q-input",
        method: "input",
        title: "Name?",
        placeholder: "type here",
      });
      client.emit({ type: "extension_ui_request", id: "n-1", method: "notify", message: "hi" });

      yield* adapter.respondToUserInput(threadId, ApprovalRequestId.make("q-select"), {
        "q-select": "Allow",
      });
      yield* adapter.respondToUserInput(threadId, ApprovalRequestId.make("q-confirm"), {
        "q-confirm": "Yes",
      });
      yield* adapter.respondToUserInput(threadId, ApprovalRequestId.make("q-input"), {
        "q-input": "custom text",
      });

      expect(client.sends).toContainEqual({
        type: "extension_ui_response",
        id: "q-select",
        value: "Allow",
      });
      expect(client.sends).toContainEqual({
        type: "extension_ui_response",
        id: "q-confirm",
        confirmed: true,
      });
      expect(client.sends).toContainEqual({
        type: "extension_ui_response",
        id: "q-input",
        value: "custom text",
      });
      const events = Array.from(yield* Fiber.join(receipts));
      expect(events.map((event) => event.type)).toEqual([
        "user-input.requested",
        "user-input.requested",
        "user-input.requested",
        "runtime.warning",
        "user-input.resolved",
        "user-input.resolved",
        "user-input.resolved",
      ]);
      expect(events[0]).toMatchObject({
        type: "user-input.requested",
        payload: {
          questions: [
            {
              id: "q-select",
              options: [
                { label: "Allow", value: "Allow" },
                { label: "Block", value: "Block" },
              ],
            },
          ],
        },
      });

      client.emit({
        type: "extension_ui_request",
        id: "q-bad",
        method: "select",
        title: "Pick",
        options: ["A", "B"],
      });
      const invalid = yield* Effect.flip(
        adapter.respondToUserInput(threadId, ApprovalRequestId.make("q-bad"), { "q-bad": "Z" }),
      );
      expect(String(invalid.detail)).toContain("Invalid Pi selection");

      yield* adapter.respondToRequest(threadId, ApprovalRequestId.make("q-bad"), "cancel");
      expect(client.sends).toContainEqual({
        type: "extension_ui_response",
        id: "q-bad",
        cancelled: true,
      });
      const wrongPolicy = yield* Effect.flip(
        adapter.respondToRequest(threadId, ApprovalRequestId.make("q-missing"), "accept"),
      );
      expect(String(wrongPolicy.detail)).toContain("structured user input");
    }),
  );

  it.effect("interrupts blocked model preflight before accepting a prompt", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const adapter = yield* makePiAdapter(harness.options);
      const threadId = ThreadId.make("thread-preflight-interrupt");
      yield* startSession(adapter, threadId);
      const client = harness.clients[0]!;
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<unknown>();
      const request = client.request.bind(client);
      client.request = (type, fields) => {
        if (type !== "set_model") return request(type, fields);
        entered.resolve();
        return release.promise;
      };
      const pending = yield* adapter
        .sendTurn({
          threadId,
          input: "must not run",
          modelSelection: createModelSelection(piInstance, "provider/model"),
        })
        .pipe(Effect.flip, Effect.forkChild);
      yield* Effect.promise(() => entered.promise);
      yield* adapter.interruptTurn(threadId);
      expect(client.requestTypes().slice(-2)).toEqual(["clear_queue", "abort"]);
      release.resolve({});
      const failure = yield* Fiber.join(pending);
      expect(failure.detail).toContain("interrupted before acceptance");
      expect(client.requestTypes()).not.toContain("prompt");
      expect(yield* adapter.hasSession(threadId)).toBe(true);
    }),
  );

  it.effect("fails the turn on prompt rejection without killing the session", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const adapter = yield* makePiAdapter(harness.options);
      const threadId = ThreadId.make("thread-failure");
      yield* startSession(adapter, threadId);
      harness.clients[0]!.failRequest("prompt", "connection reset");
      const receipts = yield* subscribe(adapter, 4);

      const failure = yield* Effect.flip(adapter.sendTurn({ threadId, input: "hello" }));
      expect(failure._tag).toBe("ProviderAdapterRequestError");
      expect(failure.method).toBe("sendTurn");
      expect(String(failure.detail)).toContain("connection reset");
      const events = Array.from(yield* Fiber.join(receipts));
      expect(events.map((event) => event.type)).toEqual([
        "turn.started",
        "session.state.changed",
        "turn.completed",
        "session.state.changed",
      ]);
      expect(events[2]).toMatchObject({
        type: "turn.completed",
        payload: { state: "failed", errorMessage: "connection reset" },
      });

      harness.clients[0]!.clearFailure("prompt");
      const recovered = yield* adapter.sendTurn({ threadId, input: "retry" });
      expect(recovered.threadId).toBe(threadId);
    }),
  );

  it.effect("keeps a steered turn open when its prompt is rejected", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const adapter = yield* makePiAdapter(harness.options);
      const threadId = ThreadId.make("thread-steer-failure");
      yield* startSession(adapter, threadId);
      harness.clients[0]!.state = { ...harness.clients[0]!.state, isStreaming: true };
      const receipts = yield* subscribe(adapter, 4);

      const first = yield* adapter.sendTurn({ threadId, input: "hello" });
      harness.clients[0]!.failRequest("prompt", "steer refused");
      const steered = yield* Effect.flip(adapter.sendTurn({ threadId, input: "steer me" }));
      expect(String(steered.detail)).toContain("steer refused");

      harness.clients[0]!.clearFailure("prompt");
      const after = yield* adapter.sendTurn({ threadId, input: "steer again" });
      expect(after.turnId).toBe(first.turnId);
      harness.clients[0]?.emit({ type: "agent_settled" });
      const events = Array.from(yield* Fiber.join(receipts));
      expect(events.map((event) => event.type)).toEqual([
        "turn.started",
        "session.state.changed",
        "turn.completed",
        "session.state.changed",
      ]);
    }),
  );

  it.effect("exits crashed sessions as errors and drops them", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const adapter = yield* makePiAdapter(harness.options);
      const threadId = ThreadId.make("thread-crash");
      yield* startSession(adapter, threadId);
      const receipts = yield* subscribe(adapter, 1);

      harness.clients[0]?.crash(new Error("boom"));
      const events = Array.from(yield* Fiber.join(receipts));
      expect(events.map((event) => event.type)).toEqual(["session.exited"]);
      expect(events[0]).toMatchObject({
        type: "session.exited",
        payload: { exitKind: "error", reason: "boom", recoverable: true },
      });
      expect(yield* adapter.hasSession(threadId)).toBe(false);
      expect(yield* adapter.listSessions()).toHaveLength(0);

      const afterCrash = yield* Effect.flip(adapter.sendTurn({ threadId, input: "hello" }));
      expect(afterCrash._tag).toBe("ProviderAdapterRequestError");

      yield* startSession(adapter, threadId);
      expect(harness.clients).toHaveLength(2);
      expect(harness.clients[1]?.closed).toBe(false);
      expect(yield* adapter.hasSession(threadId)).toBe(true);
    }),
  );

  it.effect("runs native compaction through the compact command", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const adapter = yield* makePiAdapter(harness.options);
      const threadId = ThreadId.make("thread-compact");
      yield* startSession(adapter, threadId);
      if (adapter.compaction?.type !== "native") {
        throw new Error("Expected native Pi compaction");
      }
      yield* adapter.compaction.start(threadId);
      expect(harness.clients[0]?.requestTypes()).toContain("compact");
    }),
  );
});
