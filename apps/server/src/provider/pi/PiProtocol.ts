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
]);
export type PiSideChannelMessage = typeof PiSideChannelMessage.Type;

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
