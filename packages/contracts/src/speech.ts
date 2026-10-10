import * as Schema from "effect/Schema";

import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ReadAloudVoice } from "./settings.ts";

/** Upper bound on one request; a long agent response is a few tens of thousands of characters. */
const SPEECH_SYNTHESIS_MAX_TEXT_LENGTH = 200_000;

export const SpeechSynthesisInput = Schema.Struct({
  text: TrimmedNonEmptyString.check(Schema.isMaxLength(SPEECH_SYNTHESIS_MAX_TEXT_LENGTH)),
  voice: ReadAloudVoice,
});
export type SpeechSynthesisInput = typeof SpeechSynthesisInput.Type;

/**
 * Speech is generated on the environment's host and streamed one sentence-sized
 * chunk at a time, so playback can start before the rest is generated.
 */
export const SpeechSynthesisEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("progress"),
    stage: Schema.Literals(["downloading-model", "starting", "generating"]),
    completed: NonNegativeInt,
    /** Null when the size of the stage is unknown. */
    total: Schema.NullOr(NonNegativeInt),
  }),
  Schema.Struct({
    type: Schema.Literal("chunk"),
    /** A complete 16-bit mono WAV file. */
    audio: Schema.Uint8Array,
    durationSeconds: Schema.Number,
  }),
]);
export type SpeechSynthesisEvent = typeof SpeechSynthesisEvent.Type;

export class SpeechSynthesisError extends Schema.TaggedError<SpeechSynthesisError>()(
  "SpeechSynthesisError",
  {
    reason: Schema.Literals(["model-download", "engine"]),
    message: Schema.String,
  },
) {}
