import * as Schema from "effect/Schema";

// Only the public RPC fields used by T3 are decoded here. Pi owns everything else.
export const PiModel = Schema.Struct({
  id: Schema.String,
  provider: Schema.String,
  name: Schema.optional(Schema.String),
});
export const PiState = Schema.Struct({
  sessionFile: Schema.optional(Schema.String),
  sessionId: Schema.String,
  model: Schema.optional(Schema.NullOr(PiModel)),
  isStreaming: Schema.Boolean,
});
export const PiModels = Schema.Struct({ models: Schema.Array(PiModel) });
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
  defaultModel: Schema.optional(Schema.Struct({ provider: Schema.String, modelId: Schema.String })),
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

export function piModelSelection(model: string): { provider: string; modelId: string } | undefined {
  if (model === "default") return undefined;
  const separator = model.indexOf("/");
  if (separator <= 0 || separator === model.length - 1) {
    throw new Error("Pi models must be selected as provider/modelId (or default).");
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
