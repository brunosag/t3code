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
import * as SpeechCache from "./SpeechCache.ts";
import {
  encodeWav,
  estimateRemainingSeconds,
  prepareSpeechText,
  SPEECH_SAMPLE_RATE,
  splitSpeechText,
  wavDurationSeconds,
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
     * single one already uses the cores it can; rewrites and cached chunks don't wait for them.
     */
    readonly synthesize: (
      input: SpeechSynthesisInput,
    ) => Stream.Stream<SpeechSynthesisEvent, SpeechSynthesisFailure>;
  }
>()("t3/speech/SpeechSynthesis") {}

const make = Effect.gen(function* () {
  const engine = yield* PhononEngine.PhononEngine;
  const script = yield* ReadAloudScript.ReadAloudScript;
  const cache = yield* SpeechCache.SpeechCache;
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
        const speak = Effect.fn("SpeechSynthesis.speak")(function* (speech: string) {
          const chunks = splitSpeechText(prepareSpeechText(speech));
          const generated = { characters: 0, seconds: 0 };
          const keyOf = (chunk: string) => [
            "audio",
            PhononEngine.SPEECH_ENGINE_REVISION,
            voice,
            chunk,
          ];
          const progress = (index: number) =>
            emit({
              type: "progress",
              stage: "generating",
              completed: index,
              total: chunks.length,
              ...(index > 0
                ? {
                    estimatedDurationSeconds:
                      generated.seconds + estimateRemainingSeconds(chunks.slice(index), generated),
                  }
                : {}),
            });
          const deliver = (chunk: string, audio: Uint8Array, seconds: number) => {
            generated.characters += chunk.length;
            generated.seconds += seconds;
            // Text with nothing to pronounce, such as a lone symbol, yields no audio.
            return seconds === 0
              ? Effect.void
              : emit({ type: "chunk", audio, durationSeconds: seconds });
          };
          const cached = (chunk: string) =>
            cache.get(keyOf(chunk)).pipe(
              Effect.map((audio) => {
                const seconds = audio && wavDurationSeconds(audio);
                return audio && seconds !== null ? { audio, seconds } : null;
              }),
            );
          let index = 0;
          // Chunks heard before play at once, without waiting behind another synthesis.
          for (; index < chunks.length; index++) {
            const hit = yield* cached(chunks[index]!);
            if (hit === null) break;
            yield* progress(index);
            yield* deliver(chunks[index]!, hit.audio, hit.seconds);
          }
          if (index === chunks.length) return;
          yield* emit({ type: "progress", stage: "starting", completed: 0, total: null });
          yield* permit.withPermit(
            Effect.scoped(
              Effect.gen(function* () {
                const session = yield* engine.acquire({
                  voice,
                  onDownloadProgress: (completed, total) =>
                    emit({ type: "progress", stage: "downloading-model", completed, total }),
                });
                for (; index < chunks.length; index++) {
                  const chunk = chunks[index]!;
                  yield* progress(index);
                  const hit = yield* cached(chunk);
                  if (hit !== null) {
                    yield* deliver(chunk, hit.audio, hit.seconds);
                    continue;
                  }
                  const samples = yield* session.speak(chunk);
                  const audio = encodeWav(samples);
                  // Saved before it is sent, so a listener who stops after it keeps it.
                  yield* cache.set(keyOf(chunk), audio);
                  yield* deliver(chunk, audio, samples.length / SPEECH_SAMPLE_RATE);
                }
              }),
            ),
          );
        });
        return spoken.pipe(
          Effect.flatMap(speak),
          Effect.catch((error) => Queue.fail(queue, error)),
          Effect.andThen(Queue.end(queue)),
          Effect.forkScoped,
        );
      },
    );

  return SpeechSynthesis.of({ synthesize });
});

export const layer = Layer.effect(SpeechSynthesis, make);
