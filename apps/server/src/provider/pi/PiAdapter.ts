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
  type ThreadTokenUsageSnapshot,
  type UserInputQuestion,
} from "@t3tools/contracts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { resolveAttachmentPath } from "../../attachmentStore.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import { ProviderAdapterRequestError } from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import { withPiMcpEnvironment } from "./PiMcpExtension.ts";
import { PiRpcClient } from "./PiRpcClient.ts";
import {
  PiDelta,
  PiForkMessages,
  PiForkResult,
  PiMessage,
  PiResumeCursor,
  PiSessionStats,
  PiSideChannelMessage,
  PiState,
  PiThinkingLevel,
  PiThinkingLevels,
  PiUiRequest,
  piMessageText,
  piModelSelection,
} from "./PiProtocol.ts";

const decodePiMessage = Schema.decodeUnknownSync(PiMessage);
const decodePiDelta = Schema.decodeUnknownSync(PiDelta);
const decodePiUiRequest = Schema.decodeUnknownSync(PiUiRequest);
const decodePiResumeCursor = Schema.decodeUnknownSync(PiResumeCursor);
const decodePiSideChannelMessage = Schema.decodeUnknownSync(PiSideChannelMessage);
const decodePiState = Schema.decodeUnknownSync(PiState);
const decodePiThinkingLevel = Schema.decodeUnknownOption(PiThinkingLevel);
const decodePiThinkingLevels = Schema.decodeUnknownSync(PiThinkingLevels);
const decodePiForkMessages = Schema.decodeUnknownSync(PiForkMessages);
const decodePiForkResult = Schema.decodeUnknownSync(PiForkResult);
const PROVIDER = ProviderDriverKind.make("pi");
const decodePiSessionStats = Schema.decodeUnknownSync(PiSessionStats);
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

const finiteNonNegativeInt = (value: number | null | undefined): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined;
const finitePositiveInt = (value: number | null | undefined): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : undefined;

/**
 * Maps Pi's session stats onto T3's context-window snapshot. `contextUsage.tokens`
 * is Pi's estimate of the live window, while `tokens.total` is everything billed
 * across the session; `tokens: null` (right after compaction) has no snapshot.
 */
function piContextWindowUsage(stats: PiSessionStats): ThreadTokenUsageSnapshot | undefined {
  const contextUsage = stats.contextUsage;
  if (!contextUsage) return undefined;
  const maxTokens = finitePositiveInt(contextUsage.contextWindow);
  const activeTokens = finiteNonNegativeInt(contextUsage.tokens);
  if (maxTokens === undefined || activeTokens === undefined) return undefined;

  const usedTokens = Math.min(activeTokens, maxTokens);
  const totalProcessedTokens = finiteNonNegativeInt(stats.tokens.total);
  // T3's `inputTokens` includes cache reads and writes.
  const inputTokens = finiteNonNegativeInt(
    stats.tokens.input + stats.tokens.cacheRead + stats.tokens.cacheWrite,
  );
  const outputTokens = finiteNonNegativeInt(stats.tokens.output);
  const cachedInputTokens = finiteNonNegativeInt(stats.tokens.cacheRead);

  return {
    usedTokens,
    lastUsedTokens: usedTokens,
    maxTokens,
    ...(totalProcessedTokens !== undefined && totalProcessedTokens > usedTokens
      ? { totalProcessedTokens }
      : {}),
    ...(inputTokens !== undefined && inputTokens > 0 ? { inputTokens } : {}),
    ...(outputTokens !== undefined && outputTokens > 0 ? { outputTokens } : {}),
    ...(cachedInputTokens !== undefined && cachedInputTokens > 0 ? { cachedInputTokens } : {}),
  };
}
type Client = Pick<PiRpcClient, "request" | "send" | "sendSideChannel" | "close">;
export interface PiAdapterOptions {
  binaryPath: string;
  environment: NodeJS.ProcessEnv;
  cwd: string;
  attachmentsDir: string;
  userInputExtensionPath?: string;
  /** T3's MCP-toolkit extension, loaded only for threads that have a credential. */
  mcpExtensionPath?: string;
  instanceId: ProviderInstanceId;
  createClient?: (options: ConstructorParameters<typeof PiRpcClient>[0]) => Client;
}
type PendingInput =
  | {
      kind: "rpc-ui";
      method: string;
      options?: readonly string[];
      timer?: ReturnType<typeof setTimeout>;
    }
  | { kind: "side-channel"; questions: ReadonlyArray<UserInputQuestion> };

interface Session {
  client: Client;
  session: ProviderSession;
  stopped: boolean;
  itemId?: RuntimeItemId | undefined;
  text: string;
  failure?: string | undefined;
  interrupted: boolean;
  runStarted: boolean;
  /** Last level T3 knows Pi is running with; `undefined` means "not known yet". */
  thinkingLevel?: PiThinkingLevel | undefined;
  /** Levels Pi reported for the current model; cleared whenever the model changes. */
  thinkingLevels?: readonly PiThinkingLevel[] | undefined;
  interruptEpoch: number;
  /**
   * User prompts each T3 turn appended to Pi's history, oldest turn first.
   * Steering adds a second prompt to one turn, and an extension that handles a
   * prompt itself adds none, so turns and Pi's fork targets are not one to one.
   * Only turns this process ran are known; Pi's events carry no entry ids to
   * rebuild the rest after a resume.
   */
  turnPrompts: number[];
  pending: Map<string, PendingInput>;
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
  // Pi reports context usage only on request, so refresh after each assistant
  // message to keep the composer meter live. Stats are advisory: a failed read
  // must never fail or delay the turn.
  const refreshContextWindowUsage = async (ctx: Session): Promise<void> => {
    if (ctx.stopped) return;
    let usage: ThreadTokenUsageSnapshot | undefined;
    try {
      usage = piContextWindowUsage(
        decodePiSessionStats(await ctx.client.request("get_session_stats")),
      );
    } catch {
      return;
    }
    if (!usage) return;
    emit(ctx, { type: "thread.token-usage.updated", payload: { usage } });
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
  const readThinkingLevels = async (ctx: Session): Promise<readonly PiThinkingLevel[]> => {
    try {
      return decodePiThinkingLevels(await ctx.client.request("get_available_thinking_levels"))
        .levels;
    } catch (cause) {
      throw new Error(
        `Pi did not report thinking levels for model '${ctx.session.model ?? "unknown"}' (${
          cause instanceof Error ? cause.message : String(cause)
        }).`,
        { cause },
      );
    }
  };
  // Pi silently clamps a level its model does not support, so T3 validates the
  // user's choice against Pi's own report and fails the turn instead of lying.
  const applyThinkingLevel = async (ctx: Session, requested: string): Promise<void> => {
    const level = decodePiThinkingLevel(requested);
    if (Option.isNone(level)) throw new Error(`Pi does not support thinking level '${requested}'.`);
    if (ctx.thinkingLevels?.includes(level.value) !== true)
      ctx.thinkingLevels = await readThinkingLevels(ctx);
    if (!ctx.thinkingLevels.includes(level.value))
      throw new Error(
        `Pi model '${ctx.session.model ?? "unknown"}' does not support thinking level '${
          level.value
        }'.`,
      );
    if (ctx.thinkingLevel === level.value) return;
    await ctx.client.request("set_thinking_level", { level: level.value });
    ctx.thinkingLevel = level.value;
  };
  const resumeCursorFor = (sessionPath: string): typeof PiResumeCursor.Type => ({
    version: 1,
    sessionPath,
  });
  // `fork` tears down and rebuilds Pi's runtime from the branch point, so the
  // session file, model, and thinking level T3 cached before it no longer hold.
  const resyncAfterFork = async (ctx: Session): Promise<void> => {
    const state = decodePiState(await ctx.client.request("get_state"));
    if (!state.sessionFile)
      throw new Error("Pi must provide a persistent session file for T3 resume.");
    ctx.thinkingLevel = state.thinkingLevel;
    ctx.thinkingLevels = undefined;
    const selection = ctx.session.model ? piModelSelection(ctx.session.model) : undefined;
    const model = state.model ?? undefined;
    if (
      selection &&
      (model === undefined ||
        model.provider !== selection.provider ||
        model.id !== selection.modelId)
    ) {
      await ctx.client.request("set_model", selection);
      // Pi derives its own level for the new model, so the previous one no longer holds.
      ctx.thinkingLevel = undefined;
    }
    ctx.session = {
      ...ctx.session,
      updatedAt: new Date().toISOString(),
      resumeCursor: resumeCursorFor(state.sessionFile),
    };
  };
  const resolveInput = (
    ctx: Session,
    id: string,
    response: Record<string, unknown>,
    resolvedAnswers: Record<string, unknown> = response,
    send = true,
  ) => {
    const pending = ctx.pending.get(id);
    if (!pending) throw new Error(`Pi input request ${id} is no longer pending.`);
    if (send) {
      if (pending.kind === "side-channel") {
        ctx.client.sendSideChannel({ type: "user-input.response", requestId: id, ...response });
      } else {
        ctx.client.send({ type: "extension_ui_response", id, ...response });
      }
    }
    if (pending.kind === "rpc-ui") clearTimeout(pending.timer);
    ctx.pending.delete(id);
    emit(
      ctx,
      { type: "user-input.resolved", payload: { answers: resolvedAnswers } },
      { requestId: RuntimeRequestId.make(id) },
    );
  };
  const finish = (ctx: Session, sendSideChannelCancellation = true) => {
    if (!ctx.session.activeTurnId) return;
    // Pi RPC dialogs are already gone at settlement. A side-channel tool may
    // still be awaiting its explicit cancellation response.
    for (const [id, pending] of ctx.pending)
      resolveInput(
        ctx,
        id,
        { cancelled: true },
        undefined,
        sendSideChannelCancellation && pending.kind === "side-channel",
      );
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
  const handleSideChannelMessage = (ctx: Session, value: unknown) => {
    const message = decodePiSideChannelMessage(value);
    if (message.type === "user-input.cancel") {
      const pending = ctx.pending.get(message.requestId);
      if (pending?.kind === "side-channel") {
        resolveInput(ctx, message.requestId, { cancelled: true }, undefined, false);
      }
      return;
    }
    if (ctx.pending.has(message.requestId)) {
      throw new Error(`Pi input request ${message.requestId} is already pending.`);
    }
    const ids = new Set(message.questions.map((question) => question.id));
    if (ids.size !== message.questions.length) {
      throw new Error("Pi ask_user question IDs must be unique.");
    }
    if (
      message.questions.some(
        (question) => question.options.length === 0 && question.allowCustomAnswer === false,
      )
    ) {
      throw new Error("Pi ask_user questions without options must allow a custom answer.");
    }
    ctx.pending.set(message.requestId, {
      kind: "side-channel",
      questions: message.questions,
    });
    emit(
      ctx,
      { type: "user-input.requested", payload: { questions: message.questions } },
      { requestId: RuntimeRequestId.make(message.requestId) },
    );
  };
  const handleEvent = (ctx: Session, event: Record<string, unknown>) => {
    if (ctx.stopped) return;
    try {
      switch (event.type) {
        case "agent_start":
          ctx.runStarted = true;
          break;
        // Pi changes its own level too (commands, model switches), so keep the cache honest.
        case "thinking_level_changed": {
          const level = decodePiThinkingLevel(event.level);
          if (Option.isSome(level)) ctx.thinkingLevel = level.value;
          break;
        }
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
          void refreshContextWindowUsage(ctx);
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
            const pending: Extract<PendingInput, { kind: "rpc-ui" }> = {
              kind: "rpc-ui",
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
    for (const id of ctx.pending.keys())
      resolveInput(ctx, id, { cancelled: true }, undefined, false);
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
    capabilities: { sessionModelSwitch: "in-session" },
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
          // T3 mints one MCP credential per provider session. Reading it here
          // keeps the browser, device, and pull-request toolkits on the same
          // capability decision the built-in providers already honor.
          const mcpSession = McpProviderSession.readMcpProviderSession(input.threadId);
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
            turnPrompts: [],
            pending: new Map(),
            operations: Promise.resolve(),
          };
          ctx.client = createClient({
            binaryPath: options.binaryPath,
            cwd: input.cwd ?? options.cwd,
            environment:
              mcpSession === undefined
                ? options.environment
                : withPiMcpEnvironment(options.environment, mcpSession),
            ...(mcpSession !== undefined && options.mcpExtensionPath !== undefined
              ? { extensionPaths: [options.mcpExtensionPath] }
              : {}),
            ...(cursor ? { sessionPath: cursor.sessionPath } : {}),
            onEvent: (event) => handleEvent(ctx, event),
            ...(options.userInputExtensionPath
              ? {
                  sideChannel: {
                    extensionPath: options.userInputExtensionPath,
                    onMessage: (message: unknown) => handleSideChannelMessage(ctx, message),
                  },
                }
              : {}),
            onExit: (error) => {
              if (ctx.stopped) return;
              ctx.failure = error.message;
              finish(ctx, false);
              emit(ctx, {
                type: "session.exited",
                payload: { exitKind: "error", reason: error.message, recoverable: true },
              });
              for (const pending of ctx.pending.values()) {
                if (pending.kind === "rpc-ui") clearTimeout(pending.timer);
              }
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
            // Pi reports the level for the model it is currently on, before any T3 override.
            ctx.thinkingLevel = state.thinkingLevel;
            const requestedModel = input.modelSelection?.model;
            const selection = requestedModel ? piModelSelection(requestedModel) : undefined;
            if (selection) {
              await ctx.client.request("set_model", selection);
              // Pi derives its own level for the new model, so the previous one no longer holds.
              ctx.thinkingLevel = undefined;
            }
            const reasoningEffort = getModelSelectionStringOptionValue(
              input.modelSelection,
              "reasoningEffort",
            );
            if (reasoningEffort !== undefined) await applyThinkingLevel(ctx, reasoningEffort);
            ctx.session = {
              ...ctx.session,
              status: "ready",
              ...(selection ? { model: requestedModel } : {}),
              resumeCursor: resumeCursorFor(state.sessionFile),
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
            const selection = piModelSelection(requestedModel);
            if (selection) {
              await ctx.client.request("set_model", selection);
              ctx.session = { ...ctx.session, model: requestedModel };
              // Pi derives its own level for the new model, so the previous one no longer holds.
              ctx.thinkingLevel = undefined;
              ctx.thinkingLevels = undefined;
            }
          }
          const reasoningEffort = getModelSelectionStringOptionValue(
            input.modelSelection,
            "reasoningEffort",
          );
          if (reasoningEffort !== undefined) await applyThinkingLevel(ctx, reasoningEffort);
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
            const appended = ctx.runStarted || state.isStreaming;
            const openTurnPrompts = ctx.turnPrompts.at(-1);
            if (!steering) ctx.turnPrompts.push(appended ? 1 : 0);
            else if (appended && openTurnPrompts !== undefined)
              ctx.turnPrompts[ctx.turnPrompts.length - 1] = openTurnPrompts + 1;
            if (state.sessionFile)
              ctx.session = {
                ...ctx.session,
                resumeCursor: resumeCursorFor(state.sessionFile),
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
        for (const requestId of ctx.pending.keys())
          resolveInput(ctx, requestId, { cancelled: true });
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
        resolveInput(get(id), requestId, { cancelled: true });
      }),
    respondToUserInput: (id, requestId, answers) =>
      call("respondToUserInput", async () => {
        const ctx = get(id);
        const pending = ctx.pending.get(requestId);
        if (!pending) throw new Error("Pi request is no longer pending.");
        if (pending.kind === "side-channel") {
          const resolved: Record<string, string | readonly string[]> = {};
          for (const question of pending.questions) {
            const answer = decodeAnswer(answers[question.id]);
            if (answer === undefined) throw new Error(`Missing Pi answer for '${question.id}'.`);
            if (typeof answer !== "string" && !question.multiSelect) {
              throw new Error(`Pi question '${question.id}' does not allow multiple answers.`);
            }
            // ProviderService may append validated attachment references to an
            // answer, so enforce answer cardinality here rather than exact option membership.
            if (typeof answer !== "string" && answer.length === 0) {
              throw new Error(`Missing Pi answer for '${question.id}'.`);
            }
            resolved[question.id] = answer;
          }
          resolveInput(ctx, requestId, { answers: resolved }, resolved);
          return;
        }
        const answer = decodeAnswer(answers[requestId]);
        const value = typeof answer === "string" ? answer : answer?.[0];
        if (value === undefined) return resolveInput(ctx, requestId, { cancelled: true });
        if (pending.options?.length && !pending.options.includes(value))
          throw new Error("Invalid Pi selection.");
        resolveInput(
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
    rollbackThread: (id, numTurns) =>
      call("rollbackThread", async () => {
        const ctx = get(id);
        if (!Number.isInteger(numTurns) || numTurns < 1)
          throw new Error("Pi rollback requires an integer turn count of at least 1.");
        return serialize(ctx, async () => {
          if (ctx.stopped) throw new Error("Pi session is closed.");
          if (ctx.session.activeTurnId)
            throw new Error("Interrupt the active Pi turn before rewinding the conversation.");
          const { messages } = decodePiForkMessages(await ctx.client.request("get_fork_messages"));
          const known = ctx.turnPrompts.slice(-numTurns);
          // Turns that predate this process are assumed to hold one prompt each.
          const prompts =
            known.reduce((total, count) => total + count, 0) + (numTurns - known.length);
          if (prompts === 0) return { threadId: id, turns: [] };
          const target = messages[messages.length - prompts];
          if (!target)
            throw new Error(
              `Pi cannot roll back ${prompts} message(s); the session has ${messages.length}.`,
            );
          // Forking a user message rewinds to its parent, carrying the retained
          // prefix into a fresh session file that Pi then reports as its own.
          const result = decodePiForkResult(
            await ctx.client.request("fork", { entryId: target.entryId }),
          );
          if (result.cancelled === true) throw new Error("Pi declined to rewind the conversation.");
          ctx.turnPrompts.length = Math.max(0, ctx.turnPrompts.length - numTurns);
          await resyncAfterFork(ctx);
          return { threadId: id, turns: [] };
        });
      }),
    streamEvents: Stream.fromPubSub(events),
  };
  return adapter;
});
