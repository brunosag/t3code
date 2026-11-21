import type { SpeechSynthesisEvent, SpeechSynthesisInput } from "@t3tools/contracts";
import type * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as PhononEngine from "./PhononEngine.ts";
import * as ReadAloudScript from "./readAloudScript.ts";
import {
  encodeWav,
  estimateRemainingSeconds,
  prepareSpeechText,
  SPEECH_SAMPLE_RATE,
  splitSpeechText,
} from "./speechText.ts";

type SpeechSynthesisFailure =
  | ReadAloudScript.ReadAloudScriptError
  | PhononEngine.SpeechModelDownloadError
  | PhononEngine.SpeechEngineError;

export class SpeechSynthesis extends Context.Service<
  SpeechSynthesis,
  {
    /**
     * Speaks `text` on this host, one sentence-sized WAV chunk at a time, or `markdown` as the
     * read aloud model rewrites it when one is set. Syntheses run one after another because a
     * single one already uses the cores it can; rewrites don't wait for them.
     */
    readonly synthesize: (
      input: SpeechSynthesisInput,
    ) => Stream.Stream<SpeechSynthesisEvent, SpeechSynthesisFailure>;
  }
>()("t3/speech/SpeechSynthesis") {}

const make = Effect.gen(function* () {
  const engine = yield* PhononEngine.PhononEngine;
  const script = yield* ReadAloudScript.ReadAloudScript;
  const permit = yield* Semaphore.make(1);

  const synthesize: SpeechSynthesis["Service"]["synthesize"] = ({ text, markdown, voice }) =>
    Stream.callback<SpeechSynthesisEvent, SpeechSynthesisFailure>(
      (queue: Queue.Queue<SpeechSynthesisEvent, SpeechSynthesisFailure | Cause.Done>) => {
        const emit = (event: SpeechSynthesisEvent) => Queue.offer(queue, event).pipe(Effect.asVoid);
        const spoken =
          markdown === undefined
            ? Effect.succeed(text)
            : script
                .write(
                  markdown,
                  emit({ type: "progress", stage: "wording", completed: 0, total: null }),
                )
                .pipe(Effect.map((written) => written ?? text));
        return spoken.pipe(
          Effect.tap(() =>
            emit({ type: "progress", stage: "starting", completed: 0, total: null }),
          ),
          Effect.flatMap((speech) =>
            permit.withPermit(
              Effect.scoped(
                Effect.gen(function* () {
                  const session = yield* engine.acquire({
                    voice,
                    onDownloadProgress: (completed, total) =>
                      emit({ type: "progress", stage: "downloading-model", completed, total }),
                  });
                  const chunks = splitSpeechText(prepareSpeechText(speech));
                  const generated = { characters: 0, seconds: 0 };
                  for (const [index, chunk] of chunks.entries()) {
                    yield* emit({
                      type: "progress",
                      stage: "generating",
                      completed: index,
                      total: chunks.length,
                      ...(index > 0
                        ? {
                            estimatedDurationSeconds:
                              generated.seconds +
                              estimateRemainingSeconds(chunks.slice(index), generated),
                          }
                        : {}),
                    });
                    const samples = yield* session.speak(chunk);
                    const seconds = samples.length / SPEECH_SAMPLE_RATE;
                    generated.characters += chunk.length;
                    generated.seconds += seconds;
                    // Text with nothing to pronounce, such as a lone symbol, yields no audio.
                    if (samples.length === 0) continue;
                    yield* emit({
                      type: "chunk",
                      audio: encodeWav(samples),
                      durationSeconds: seconds,
                    });
                  }
                }),
              ),
            ),
          ),
          Effect.catch((error) => Queue.fail(queue, error)),
          Effect.andThen(Queue.end(queue)),
          Effect.forkScoped,
        );
      },
    );

  return SpeechSynthesis.of({ synthesize });
});

export const layer = Layer.effect(SpeechSynthesis, make);
