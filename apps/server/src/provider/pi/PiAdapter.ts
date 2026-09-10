// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off - Promise/callback boundary for the external RPC process; timers are cleared with its owner.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import {
  EventId,
  ProviderDriverKind,
  RuntimeItemId,
  RuntimeRequestId,
  TurnId,
  type ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderRuntimeEventBase,
  type ProviderSession,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ProviderAdapterRequestError } from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import { PiRpcClient } from "./PiRpcClient.ts";
import {
  PiDelta,
  PiMessage,
  PiResumeCursor,
  PiState,
  PiUiRequest,
  piMessageText,
  piModelSelection,
} from "./PiProtocol.ts";

const decodePiMessage = Schema.decodeUnknownSync(PiMessage);
const decodePiDelta = Schema.decodeUnknownSync(PiDelta);
const decodePiUiRequest = Schema.decodeUnknownSync(PiUiRequest);
const decodePiResumeCursor = Schema.decodeUnknownSync(PiResumeCursor);
const decodePiState = Schema.decodeUnknownSync(PiState);
const PROVIDER = ProviderDriverKind.make("pi");
const decodeAnswer = Schema.decodeUnknownSync(
  Schema.optional(Schema.Union([Schema.String, Schema.Array(Schema.String)])),
);
const decodeTool = Schema.decodeUnknownSync(
  Schema.Struct({
    toolCallId: Schema.String,
    toolName: Schema.String,
    isError: Schema.optional(Schema.Boolean),
  }),
);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeToolResult = Schema.decodeUnknownOption(
  Schema.Struct({
    content: Schema.Array(
      Schema.Struct({ type: Schema.String, text: Schema.optional(Schema.String) }),
    ),
  }),
);
const toolDetail = (value: unknown): string | undefined => {
  const decoded = decodeToolResult(value);
  if (Option.isNone(decoded)) return undefined;
  return (
    decoded.value.content
      .filter((part) => part.type === "text")
      .map((part) => part.text ?? "")
      .join("\n")
      .slice(0, 12_000) || undefined
  );
};
type EventBody = ProviderRuntimeEvent extends infer E
  ? E extends ProviderRuntimeEvent
    ? Pick<E, "type" | "payload">
    : never
  : never;
type Client = Pick<PiRpcClient, "request" | "send" | "close">;
export interface PiAdapterOptions {
  binaryPath: string;
  environment: NodeJS.ProcessEnv;
  cwd: string;
  attachmentsDir: string;
  instanceId: ProviderInstanceId;
  createClient?: (options: ConstructorParameters<typeof PiRpcClient>[0]) => Client;
}
interface Session {
  client: Client;
  session: ProviderSession;
  defaultModel?: typeof PiResumeCursor.Type.defaultModel;
  stopped: boolean;
  itemId?: RuntimeItemId | undefined;
  text: string;
  failure?: string | undefined;
  interrupted: boolean;
  runStarted: boolean;
  interruptEpoch: number;
  pending: Map<
    string,
    { method: string; options?: readonly string[]; timer?: ReturnType<typeof setTimeout> }
  >;
  operations: Promise<unknown>;
}

export const makePiAdapter = Effect.fn("makePiAdapter")(function* (options: PiAdapterOptions) {
  const events = yield* PubSub.unbounded<ProviderRuntimeEvent>();
  const sessions = new Map<ThreadId, Session>();
  const starting = new Map<ThreadId, Promise<ProviderSession>>();
  const createClient = options.createClient ?? ((input) => new PiRpcClient(input));
  let closed = false;
  const emit = (ctx: Session, body: EventBody, refs: Partial<ProviderRuntimeEventBase> = {}) => {
    if (ctx.stopped) return;
    PubSub.publishUnsafe(events, {
      eventId: EventId.make(NodeCrypto.randomUUID()),
      provider: PROVIDER,
      providerInstanceId: options.instanceId,
      threadId: ctx.session.threadId,
      createdAt: new Date().toISOString(),
      ...(ctx.session.activeTurnId ? { turnId: ctx.session.activeTurnId } : {}),
      ...refs,
      ...body,
    } as ProviderRuntimeEvent);
  };
  const get = (id: ThreadId) => {
    const ctx = sessions.get(id);
    if (!ctx || ctx.stopped) throw new Error(`No live Pi session for ${id}.`);
    return ctx;
  };
  const call = <A>(method: string, run: () => Promise<A>) =>
    Effect.tryPromise({
      try: run,
      catch: (cause) =>
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method,
          detail: cause instanceof Error ? cause.message : String(cause),
          cause,
        }),
    });
  const serialize = <A>(ctx: Session, run: () => Promise<A>): Promise<A> => {
    const next = ctx.operations.then(run);
    ctx.operations = next.catch(() => {});
    return next;
  };
  const resolveUi = (ctx: Session, id: string, response: Record<string, unknown>, send = true) => {
    const pending = ctx.pending.get(id);
    if (!pending) throw new Error(`Pi input request ${id} is no longer pending.`);
    if (send) ctx.client.send({ type: "extension_ui_response", id, ...response });
    clearTimeout(pending.timer);
    ctx.pending.delete(id);
    emit(
      ctx,
      { type: "user-input.resolved", payload: { answers: response } },
      { requestId: RuntimeRequestId.make(id) },
    );
  };
  const finish = (ctx: Session) => {
    if (!ctx.session.activeTurnId) return;
    // Settlement/exit means Pi no longer awaits these dialogs. Resolve only the T3 UI.
    for (const id of ctx.pending.keys()) resolveUi(ctx, id, { cancelled: true }, false);
    emit(ctx, {
      type: "turn.completed",
      payload: {
        state: ctx.interrupted ? "interrupted" : ctx.failure ? "failed" : "completed",
        ...(ctx.failure ? { errorMessage: ctx.failure } : {}),
      },
    });
    const { activeTurnId: _, ...rest } = ctx.session;
    ctx.session = { ...rest, status: "ready", updatedAt: new Date().toISOString() };
    // A ready event would clear the failed turn's visible error in orchestration.
    if (!ctx.failure) emit(ctx, { type: "session.state.changed", payload: { state: "ready" } });
  };
  const handleEvent = (ctx: Session, event: Record<string, unknown>) => {
    if (ctx.stopped) return;
    try {
      switch (event.type) {
        case "agent_start":
          ctx.runStarted = true;
          break;
        case "message_start": {
          const message = decodePiMessage(event.message);
          if (message.role !== "assistant") break;
          ctx.itemId = RuntimeItemId.make(NodeCrypto.randomUUID());
          ctx.text = "";
          emit(
            ctx,
            { type: "item.started", payload: { itemType: "assistant_message" } },
            { itemId: ctx.itemId },
          );
          break;
        }
        case "message_update": {
          const delta = decodePiDelta(event.assistantMessageEvent);
          if (delta.type !== "text_delta" && delta.type !== "thinking_delta") break;
          if (!ctx.itemId) ctx.itemId = RuntimeItemId.make(NodeCrypto.randomUUID());
          if (delta.type === "text_delta") ctx.text += delta.delta ?? "";
          emit(
            ctx,
            {
              type: "content.delta",
              payload: {
                streamKind: delta.type === "text_delta" ? "assistant_text" : "reasoning_text",
                delta: delta.delta ?? "",
                ...(delta.contentIndex !== undefined ? { contentIndex: delta.contentIndex } : {}),
              },
            },
            { itemId: ctx.itemId },
          );
          break;
        }
        case "message_end": {
          const message = decodePiMessage(event.message);
          if (message.role !== "assistant") break;
          if (!ctx.itemId) ctx.itemId = RuntimeItemId.make(NodeCrypto.randomUUID());
          const text = piMessageText(message);
          if (text.startsWith(ctx.text) && text.length > ctx.text.length) {
            emit(
              ctx,
              {
                type: "content.delta",
                payload: { streamKind: "assistant_text", delta: text.slice(ctx.text.length) },
              },
              { itemId: ctx.itemId },
            );
          }
          ctx.failure =
            message.stopReason === "error"
              ? message.errorMessage || "Pi model request failed."
              : undefined;
          if (message.stopReason === "aborted") ctx.interrupted = true;
          emit(
            ctx,
            {
              type: "item.completed",
              payload: { itemType: "assistant_message", ...(text ? { detail: text } : {}) },
            },
            { itemId: ctx.itemId },
          );
          ctx.itemId = undefined;
          ctx.text = "";
          break;
        }
        case "tool_execution_start":
        case "tool_execution_update":
        case "tool_execution_end": {
          const tool = decodeTool(event);
          emit(
            ctx,
            {
              type:
                event.type === "tool_execution_start"
                  ? "item.started"
                  : event.type === "tool_execution_end"
                    ? "item.completed"
                    : "item.updated",
              payload: {
                itemType: "dynamic_tool_call",
                title: tool.toolName,
                status:
                  event.type === "tool_execution_end"
                    ? tool.isError
                      ? "failed"
                      : "completed"
                    : "inProgress",
                ...(toolDetail(event.result ?? event.partialResult)
                  ? { detail: toolDetail(event.result ?? event.partialResult)! }
                  : {}),
                // Keep extension internals and image/base64 results off the wire.
                data: {
                  toolName: tool.toolName,
                  ...(event.args !== undefined
                    ? { input: encodeJson(event.args).slice(0, 12_000) }
                    : {}),
                },
              },
            },
            { itemId: RuntimeItemId.make(tool.toolCallId) },
          );
          break;
        }
        // agent_end is NOT settlement: Pi may retry, compact, or run a follow-up.
        case "agent_settled":
          finish(ctx);
          break;
        case "compaction_end":
          if (event.result)
            emit(ctx, { type: "thread.state.changed", payload: { state: "compacted" } });
          break;
        case "auto_retry_start":
        case "extension_error":
          emit(ctx, {
            type: "runtime.warning",
            payload: {
              message:
                typeof event.errorMessage === "string"
                  ? event.errorMessage
                  : typeof event.error === "string"
                    ? event.error
                    : "Pi is retrying.",
            },
          });
          break;
        case "extension_ui_request": {
          const req = decodePiUiRequest(event);
          if (["confirm", "select", "input", "editor"].includes(req.method)) {
            const choices = req.method === "confirm" ? ["Yes", "No"] : (req.options ?? []);
            const pending: Session["pending"] extends Map<string, infer P> ? P : never = {
              method: req.method,
              options: choices,
            };
            ctx.pending.set(req.id, pending);
            emit(
              ctx,
              {
                type: "user-input.requested",
                payload: {
                  questions: [
                    {
                      id: req.id,
                      header: "Pi",
                      question:
                        [req.title, req.message, req.placeholder, req.prefill]
                          .filter(Boolean)
                          .join("\n") || "Pi requests input",
                      options: choices.map((label) => ({
                        label: label || "(empty)",
                        value: label,
                        description: "",
                      })),
                      allowCustomAnswer: req.method === "input" || req.method === "editor",
                      multiSelect: false,
                    },
                  ],
                },
              },
              { requestId: RuntimeRequestId.make(req.id) },
            );
            if (req.timeout !== undefined)
              pending.timer = setTimeout(
                () => {
                  if (!ctx.stopped && ctx.pending.has(req.id)) {
                    clearTimeout(pending.timer);
                    ctx.pending.delete(req.id);
                    emit(
                      ctx,
                      { type: "user-input.resolved", payload: { answers: { cancelled: true } } },
                      { requestId: RuntimeRequestId.make(req.id) },
                    );
                  }
                },
                Math.max(0, req.timeout),
              );
            pending.timer?.unref();
          } else if (req.method === "notify" && req.message) {
            emit(ctx, { type: "runtime.warning", payload: { message: req.message } });
          }
          break;
        }
      }
    } catch (cause) {
      ctx.failure = `Invalid Pi RPC event: ${cause instanceof Error ? cause.message : String(cause)}`;
      emit(ctx, { type: "runtime.warning", payload: { message: ctx.failure } });
    }
  };
  const stop = async (ctx: Session) => {
    if (ctx.stopped) return;
    for (const id of ctx.pending.keys()) resolveUi(ctx, id, { cancelled: true }, false);
    emit(ctx, { type: "session.exited", payload: { exitKind: "graceful", recoverable: true } });
    ctx.stopped = true;
    sessions.delete(ctx.session.threadId);
    await ctx.client.close();
  };
  const stopAll = async () => {
    await Promise.allSettled(starting.values());
    await Promise.all([...sessions.values()].map(stop));
  };
  yield* Effect.addFinalizer(() =>
    call("close", async () => {
      closed = true;
      await stopAll();
    }).pipe(Effect.orDie),
  );

  const adapter: ProviderAdapterShape<ProviderAdapterRequestError> = {
    provider: PROVIDER,
    capabilities: { sessionModelSwitch: "in-session", supportsConversationRollback: false },
    startSession: (input) =>
      call("startSession", async () => {
        if (closed) throw new Error("Pi adapter is closed.");
        const existing = sessions.get(input.threadId);
        if (existing && !existing.stopped) return existing.session;
        const inFlight = starting.get(input.threadId);
        if (inFlight) return inFlight;
        const start = async () => {
          const cursor =
            input.resumeCursor === undefined ? undefined : decodePiResumeCursor(input.resumeCursor);
          if (cursor) {
            if (!NodePath.isAbsolute(cursor.sessionPath))
              throw new Error("Pi resume path must be absolute.");
            // Pi treats a missing --session path as a new session; never silently lose history.
            await NodeFSP.access(cursor.sessionPath);
          }
          const now = new Date().toISOString();
          const ctx: Session = {
            client: undefined as unknown as Client,
            session: {
              provider: PROVIDER,
              providerInstanceId: options.instanceId,
              threadId: input.threadId,
              runtimeMode: input.runtimeMode,
              cwd: input.cwd ?? options.cwd,
              status: "connecting",
              createdAt: now,
              updatedAt: now,
            },
            stopped: false,
            text: "",
            interrupted: false,
            runStarted: false,
            interruptEpoch: 0,
            pending: new Map(),
            operations: Promise.resolve(),
          };
          ctx.client = createClient({
            binaryPath: options.binaryPath,
            cwd: input.cwd ?? options.cwd,
            environment: options.environment,
            ...(cursor ? { sessionPath: cursor.sessionPath } : {}),
            onEvent: (event) => handleEvent(ctx, event),
            onExit: (error) => {
              if (ctx.stopped) return;
              ctx.failure = error.message;
              finish(ctx);
              emit(ctx, {
                type: "session.exited",
                payload: { exitKind: "error", reason: error.message, recoverable: true },
              });
              for (const pending of ctx.pending.values()) clearTimeout(pending.timer);
              ctx.stopped = true;
              sessions.delete(input.threadId);
            },
          });
          try {
            const state = decodePiState(await ctx.client.request("get_state"));
            if (!state.sessionFile)
              throw new Error("Pi must provide a persistent session file for T3 resume.");
            if (cursor && state.sessionFile !== cursor.sessionPath)
              throw new Error("Pi resumed a different session than requested.");
            // Capture Pi's choice before any T3 override, retaining it across process resumes.
            ctx.defaultModel =
              cursor?.defaultModel ??
              (state.model
                ? { provider: state.model.provider, modelId: state.model.id }
                : undefined);
            const selection =
              piModelSelection(input.modelSelection?.model ?? "default") ?? cursor?.defaultModel;
            if (selection) await ctx.client.request("set_model", selection);
            ctx.session = {
              ...ctx.session,
              status: "ready",
              model: input.modelSelection?.model ?? "default",
              resumeCursor: {
                version: 1,
                sessionPath: state.sessionFile,
                ...(ctx.defaultModel ? { defaultModel: ctx.defaultModel } : {}),
              },
            };
            if (ctx.stopped) throw new Error("Pi exited during initialization.");
            sessions.set(input.threadId, ctx);
            emit(ctx, { type: "session.started", payload: { resume: ctx.session.resumeCursor } });
            emit(ctx, { type: "session.state.changed", payload: { state: "ready" } });
            return ctx.session;
          } catch (error) {
            ctx.stopped = true;
            await ctx.client.close();
            throw error;
          }
        };
        const promise = start();
        starting.set(input.threadId, promise);
        try {
          return await promise;
        } finally {
          starting.delete(input.threadId);
        }
      }),
    sendTurn: (input) =>
      call("sendTurn", async () => {
        const ctx = get(input.threadId);
        const epoch = ctx.interruptEpoch;
        return serialize(ctx, async () => {
          if (ctx.stopped) throw new Error("Pi session is closed.");
          if (input.interactionMode === "plan")
            throw new Error(
              "Pi owns planning behavior; use your configured Pi commands or extensions.",
            );
          const images = await Promise.all(
            (input.attachments ?? [])
              .filter((a) => a.type === "image")
              .map(async (attachment) => {
                const path = resolveAttachmentPath({
                  attachmentsDir: options.attachmentsDir,
                  attachment,
                });
                if (!path) throw new Error("Invalid Pi image attachment.");
                return {
                  type: "image",
                  data: (await NodeFSP.readFile(path)).toString("base64"),
                  mimeType: attachment.mimeType,
                };
              }),
          );
          if (!input.input && images.length === 0)
            throw new Error("Pi requires a prompt or image.");
          const requestedModel = input.modelSelection?.model;
          if (requestedModel && requestedModel !== ctx.session.model) {
            const selection = piModelSelection(requestedModel) ?? ctx.defaultModel;
            if (!selection)
              throw new Error("Pi did not report an initial model; cannot restore Pi default.");
            await ctx.client.request("set_model", selection);
            ctx.session = { ...ctx.session, model: requestedModel };
          }
          if (ctx.stopped || ctx.interruptEpoch !== epoch)
            throw new Error("Pi prompt was interrupted before acceptance.");
          const steering = !!ctx.session.activeTurnId;
          const turnId = ctx.session.activeTurnId ?? TurnId.make(NodeCrypto.randomUUID());
          if (!steering) {
            ctx.failure = undefined;
            ctx.interrupted = false;
            ctx.runStarted = false;
            ctx.session = {
              ...ctx.session,
              activeTurnId: turnId,
              status: "running",
              updatedAt: new Date().toISOString(),
            };
            emit(ctx, { type: "turn.started", payload: {} });
            emit(ctx, { type: "session.state.changed", payload: { state: "running" } });
          }
          try {
            await ctx.client.request("prompt", {
              message: input.input ?? "",
              ...(images.length ? { images } : {}),
              ...(steering ? { streamingBehavior: "steer" } : {}),
            });
            // Extension commands may be handled without ever starting an agent run.
            const state = decodePiState(await ctx.client.request("get_state"));
            if (state.sessionFile)
              ctx.session = {
                ...ctx.session,
                resumeCursor: {
                  version: 1,
                  sessionPath: state.sessionFile,
                  ...(ctx.defaultModel ? { defaultModel: ctx.defaultModel } : {}),
                },
              };
            if (!ctx.runStarted && !state.isStreaming && ctx.session.activeTurnId === turnId)
              finish(ctx);
            return { threadId: input.threadId, turnId, resumeCursor: ctx.session.resumeCursor };
          } catch (error) {
            if (!steering) {
              ctx.failure = error instanceof Error ? error.message : String(error);
              finish(ctx);
            }
            throw error;
          }
        });
      }),
    interruptTurn: (id, turnId) =>
      call("abort", async () => {
        const ctx = get(id);
        if (turnId && ctx.session.activeTurnId !== turnId) return;
        ctx.interrupted = true;
        ctx.interruptEpoch += 1;
        for (const requestId of ctx.pending.keys()) resolveUi(ctx, requestId, { cancelled: true });
        const previous = ctx.operations;
        const abort = (async () => {
          await ctx.client.request("clear_queue");
          await ctx.client.request("abort");
          finish(ctx);
        })();
        // Interrupt in-flight preflight immediately, but keep later prompts behind abort.
        ctx.operations = Promise.allSettled([previous, abort]);
        await abort;
      }),
    respondToRequest: (id, requestId, decision) =>
      call("respondToRequest", async () => {
        if (decision !== "cancel" && decision !== "decline")
          throw new Error("Pi dialogs use structured user input, not T3 permission policy.");
        resolveUi(get(id), requestId, { cancelled: true });
      }),
    respondToUserInput: (id, requestId, answers) =>
      call("respondToUserInput", async () => {
        const ctx = get(id);
        const pending = ctx.pending.get(requestId);
        if (!pending) throw new Error("Pi request is no longer pending.");
        const answer = decodeAnswer(answers[requestId]);
        const value = typeof answer === "string" ? answer : answer?.[0];
        if (value === undefined) return resolveUi(ctx, requestId, { cancelled: true });
        if (pending.options?.length && !pending.options.includes(value))
          throw new Error("Invalid Pi selection.");
        resolveUi(
          ctx,
          requestId,
          pending.method === "confirm" ? { confirmed: value === "Yes" } : { value },
        );
      }),
    compaction: {
      type: "native",
      start: (id) =>
        call("compact", async () => {
          await get(id).client.request("compact");
        }),
    },
    stopSession: (id) =>
      call("stopSession", async () => {
        await starting.get(id);
        const ctx = sessions.get(id);
        if (ctx) await stop(ctx);
      }),
    stopAll: () => call("stopAll", stopAll),
    listSessions: () => Effect.sync(() => [...sessions.values()].map((ctx) => ctx.session)),
    hasSession: (id) => Effect.sync(() => sessions.has(id)),
    readThread: (id) =>
      call("readThread", async () => {
        get(id);
        return { threadId: id, turns: [] };
      }),
    rollbackThread: () =>
      call("rollbackThread", async () => {
        throw new Error(
          "Pi RPC does not support in-place conversation rollback. Use a new thread; Git diff and worktrees remain managed by T3.",
        );
      }),
    streamEvents: Stream.fromPubSub(events),
  };
  return adapter;
});
