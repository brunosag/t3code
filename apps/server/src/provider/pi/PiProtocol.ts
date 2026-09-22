import { UserInputQuestion } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

// Only the public RPC fields used by T3 are decoded here. Pi owns everything else.
export const PiModel = Schema.Struct({
  id: Schema.String,
  provider: Schema.String,
  name: Schema.optional(Schema.String),
});
// Pi's `ThinkingLevel`. Unknown values are a protocol mismatch, not a level to guess at.
export const PiThinkingLevel = Schema.Literals([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
export type PiThinkingLevel = typeof PiThinkingLevel.Type;
export const PiThinkingLevels = Schema.Struct({ levels: Schema.Array(PiThinkingLevel) });
export const PiState = Schema.Struct({
  sessionFile: Schema.optional(Schema.String),
  sessionId: Schema.String,
  model: Schema.optional(Schema.NullOr(PiModel)),
  isStreaming: Schema.Boolean,
  // Absent on Pi builds that predate thinking levels; those expose no picker.
  thinkingLevel: Schema.optional(PiThinkingLevel),
});
export const PiModels = Schema.Struct({ models: Schema.Array(PiModel) });
// `get_session_stats` carries the current context estimate plus session-wide token
// totals. Pi omits `contextUsage` for models it cannot size (no context window) and
// reports `tokens: null` in it right after a compaction, before the next response.
export const PiContextUsage = Schema.Struct({
  tokens: Schema.NullOr(Schema.Finite),
  contextWindow: Schema.Finite,
  percent: Schema.NullOr(Schema.Finite),
});
export const PiSessionStats = Schema.Struct({
  tokens: Schema.Struct({
    input: Schema.Finite,
    output: Schema.Finite,
    cacheRead: Schema.Finite,
    cacheWrite: Schema.Finite,
    total: Schema.Finite,
  }),
  contextUsage: Schema.optional(PiContextUsage),
});
export type PiSessionStats = typeof PiSessionStats.Type;
// `get_fork_messages` lists the user prompts Pi can rewind to, oldest first.
// Tool results carry their own role, so only real prompts appear here.
export const PiForkMessages = Schema.Struct({
  messages: Schema.Array(
    Schema.Struct({
      entryId: Schema.String.check(Schema.isMinLength(1)),
      text: Schema.String,
    }),
  ),
});
// An extension's `before_fork` hook may veto the rewind, leaving Pi's history untouched.
export const PiForkResult = Schema.Struct({
  cancelled: Schema.optional(Schema.Boolean),
});
export const PiCommands = Schema.Struct({
  commands: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      description: Schema.optional(Schema.String),
    }),
  ),
});
export const PiResumeCursor = Schema.Struct({
  version: Schema.Literal(1),
  sessionPath: Schema.String.check(Schema.isMinLength(1)),
});
export const PiMessage = Schema.Struct({
  role: Schema.String,
  content: Schema.optional(
    Schema.Union([
      Schema.String,
      Schema.Array(
        Schema.Struct({
          type: Schema.String,
          text: Schema.optional(Schema.String),
          thinking: Schema.optional(Schema.String),
        }),
      ),
    ]),
  ),
  stopReason: Schema.optional(Schema.String),
  errorMessage: Schema.optional(Schema.String),
  // Custom messages carry the extension's own type and payload. T3 reads
  // `subagent-notification` to settle background agents; everything else is
  // still parsed as ordinary text.
  customType: Schema.optional(Schema.String),
  details: Schema.optional(Schema.Unknown),
});
export const PiDelta = Schema.Struct({
  type: Schema.String,
  delta: Schema.optional(Schema.String),
  contentIndex: Schema.optional(Schema.Int),
});
export const PiUiRequest = Schema.Struct({
  id: Schema.String,
  method: Schema.String,
  title: Schema.optional(Schema.String),
  message: Schema.optional(Schema.String),
  options: Schema.optional(Schema.Array(Schema.String)),
  placeholder: Schema.optional(Schema.String),
  prefill: Schema.optional(Schema.String),
  timeout: Schema.optional(Schema.Number),
});

export const PiSideChannelMessage = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("user-input.request"),
    requestId: Schema.String.check(Schema.isMinLength(1)),
    questions: Schema.Array(UserInputQuestion).check(Schema.isMinLength(1)),
  }),
  Schema.Struct({
    type: Schema.Literal("user-input.cancel"),
    requestId: Schema.String.check(Schema.isMinLength(1)),
  }),
  /**
   * A settled pi-subagents run, forwarded by T3's agent extension off the
   * extension's event bus. This is the terminal signal that survives when the
   * extension suppresses the parent notification (the parent consumed the
   * result via `get_subagent_result`), which would otherwise leave a finished
   * background agent looking like it was still running.
   */
  Schema.Struct({
    type: Schema.Literal("subagent.activity"),
    event: Schema.Literals(["completed", "failed"]),
    agentId: Schema.String.check(Schema.isMinLength(1)),
    agentType: Schema.optional(Schema.String),
    description: Schema.optional(Schema.String),
    /** Raw pi-subagents status (completed/error/stopped/aborted/…). */
    status: Schema.optional(Schema.String),
    error: Schema.optional(Schema.String),
    result: Schema.optional(Schema.String),
    toolUses: Schema.optional(Schema.Finite),
    durationMs: Schema.optional(Schema.Finite),
    tokens: Schema.optional(
      Schema.Struct({
        input: Schema.Finite,
        output: Schema.Finite,
        total: Schema.Finite,
      }),
    ),
  }),
  /**
   * The agent-extension's verdict on its own roster push: whether Pi's
   * subagents handler exists, accepted the payload, and read the definitions
   * file. `ok: false` means Pi's own agent files would run instead of T3's,
   * which has no other visible symptom — so T3 turns it into a runtime warning.
   */
  Schema.Struct({
    type: Schema.Literal("subagent.registration"),
    requestId: Schema.String.check(Schema.isMinLength(1)),
    ok: Schema.Boolean,
    count: Schema.optional(Schema.Finite),
    error: Schema.optional(Schema.String),
  }),
]);
export type PiSideChannelMessage = typeof PiSideChannelMessage.Type;

/**
 * The pi-subagents extension attaches this to the `Agent` tool's `result` and
 * `partialResult`. It is extension-owned rather than part of Pi's RPC protocol,
 * so every field is optional and an unrecognized status is ignored instead of
 * failing the turn. `tokens` is the extension's preformatted display string
 * ("33.8k token"); numeric totals only arrive on a completion notification.
 */
export const PiAgentDetails = Schema.Struct({
  displayName: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  subagentType: Schema.optional(Schema.String),
  modelName: Schema.optional(Schema.String),
  tags: Schema.optional(Schema.Array(Schema.String)),
  status: Schema.optional(Schema.String),
  activity: Schema.optional(Schema.String),
  agentId: Schema.optional(Schema.String),
  toolUses: Schema.optional(Schema.Finite),
  turnCount: Schema.optional(Schema.Finite),
  maxTurns: Schema.optional(Schema.Finite),
  durationMs: Schema.optional(Schema.Finite),
  tokens: Schema.optional(Schema.String),
  cost: Schema.optional(Schema.Finite),
  error: Schema.optional(Schema.String),
});
export type PiAgentDetails = typeof PiAgentDetails.Type;

/**
 * Details on the `subagent-notification` custom message — how a *background*
 * agent's terminal state reaches the parent. A group completion carries the
 * remaining agents in `others`, so one notification can settle several tasks.
 */
export const PiAgentNotification = Schema.Struct({
  id: Schema.String,
  description: Schema.optional(Schema.String),
  status: Schema.optional(Schema.String),
  toolUses: Schema.optional(Schema.Finite),
  turnCount: Schema.optional(Schema.Finite),
  maxTurns: Schema.optional(Schema.Finite),
  totalTokens: Schema.optional(Schema.Finite),
  totalCost: Schema.optional(Schema.Finite),
  durationMs: Schema.optional(Schema.Finite),
  outputFile: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
  resultPreview: Schema.optional(Schema.String),
  // Same shape as the parent, recursively; decoded per element by the adapter.
  others: Schema.optional(Schema.Array(Schema.Unknown)),
});
export type PiAgentNotification = typeof PiAgentNotification.Type;

// T3 selects Pi models as `provider/modelId`. The removed synthetic `default`
// selection is tolerated so threads that still carry it keep running whatever
// model Pi already has instead of failing their next turn.
export function piModelSelection(model: string): { provider: string; modelId: string } | undefined {
  if (model === "default") return undefined;
  const separator = model.indexOf("/");
  if (separator <= 0 || separator === model.length - 1) {
    throw new Error("Pi models must be selected as provider/modelId.");
  }
  return { provider: model.slice(0, separator), modelId: model.slice(separator + 1) };
}

export function piMessageText(message: typeof PiMessage.Type): string {
  return typeof message.content === "string"
    ? message.content
    : (message.content ?? [])
        .filter((part) => part.type === "text")
        .map((part) => part.text ?? "")
        .join("");
}
