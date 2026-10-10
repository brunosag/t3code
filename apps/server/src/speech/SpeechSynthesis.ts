import type { SpeechSynthesisEvent, SpeechSynthesisInput } from "@t3tools/contracts";
import type * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as KokoroEngine from "./KokoroEngine.ts";
import {
  encodeWav,
  finishPhonemes,
  fitPhonemes,
  KOKORO_SAMPLE_RATE,
  modelInputIds,
  phonemeLanguage,
  phonemeSections,
  splitSpeechText,
} from "./kokoroText.ts";

type SpeechSynthesisFailure =
  | KokoroEngine.SpeechModelDownloadError
  | KokoroEngine.SpeechEngineError;

export class SpeechSynthesis extends Context.Service<
  SpeechSynthesis,
  {
    /**
     * Speaks `text` on this host, one sentence-sized WAV chunk at a time. Requests run
     * one after another because a single synthesis already uses the cores it can.
     */
    readonly synthesize: (
      input: SpeechSynthesisInput,
    ) => Stream.Stream<SpeechSynthesisEvent, SpeechSynthesisFailure>;
  }
>()("t3/speech/SpeechSynthesis") {}

function concatSamples(parts: ReadonlyArray<Float32Array>): Float32Array {
  const samples = new Float32Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    samples.set(part, offset);
    offset += part.length;
  }
  return samples;
}

const make = Effect.gen(function* () {
  const engine = yield* KokoroEngine.KokoroEngine;
  const permit = yield* Semaphore.make(1);

  const synthesize: SpeechSynthesis["Service"]["synthesize"] = ({ text, voice }) =>
    Stream.callback<SpeechSynthesisEvent, SpeechSynthesisFailure>(
      (queue: Queue.Queue<SpeechSynthesisEvent, SpeechSynthesisFailure | Cause.Done>) => {
        const emit = (event: SpeechSynthesisEvent) => Queue.offer(queue, event).pipe(Effect.asVoid);
        return emit({ type: "progress", stage: "starting", completed: 0, total: null })
          .pipe(
            Effect.andThen(
              permit.withPermit(
                Effect.scoped(
                  Effect.gen(function* () {
                    const session = yield* engine.acquire({
                      voice,
                      onDownloadProgress: (completed, total) =>
                        emit({ type: "progress", stage: "downloading-model", completed, total }),
                    });
                    const chunks = splitSpeechText(text);
                    for (const [index, chunk] of chunks.entries()) {
                      yield* emit({
                        type: "progress",
                        stage: "generating",
                        completed: index,
                        total: chunks.length,
                      });
                      const phonemes = finishPhonemes(
                        yield* Effect.forEach(phonemeSections(chunk), (section) =>
                          section.punctuation
                            ? Effect.succeed(section.text)
                            : session
                                .phonemize(section.text, phonemeLanguage(voice))
                                .pipe(Effect.map((lines) => lines.join(" "))),
                        ),
                        voice,
                      );
                      const samples = concatSamples(
                        yield* Effect.forEach(fitPhonemes(phonemes, session.vocab), (piece) =>
                          session.infer(modelInputIds(piece, session.vocab)),
                        ),
                      );
                      // Text with nothing to pronounce, such as a lone symbol, yields no audio.
                      if (samples.length === 0) continue;
                      yield* emit({
                        type: "chunk",
                        audio: encodeWav(samples),
                        durationSeconds: samples.length / KOKORO_SAMPLE_RATE,
                      });
                    }
                  }),
                ),
              ),
            ),
          )
          .pipe(
            Effect.catch((error) => Queue.fail(queue, error)),
            Effect.andThen(Queue.end(queue)),
            Effect.forkScoped,
          );
      },
    );

  return SpeechSynthesis.of({ synthesize });
});

export const layer = Layer.effect(SpeechSynthesis, make);
