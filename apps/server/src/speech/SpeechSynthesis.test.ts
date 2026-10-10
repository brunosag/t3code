import { describe, expect, it } from "@effect/vitest";
import type { SpeechSynthesisEvent } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as KokoroEngine from "./KokoroEngine.ts";
import { KOKORO_SAMPLE_RATE } from "./kokoroText.ts";
import * as SpeechSynthesis from "./SpeechSynthesis.ts";

const vocab = new Map(
  [..."abcdefghijklmnopqrstuvwxyz ,.!?"].map((symbol, index) => [symbol, index + 1]),
);

interface FakeEngineOptions {
  readonly onAcquire?: Effect.Effect<void>;
  readonly onInfer?: (
    ids: ReadonlyArray<number>,
  ) => Effect.Effect<void, KokoroEngine.SpeechEngineError>;
  readonly downloadProgress?: ReadonlyArray<readonly [number, number]>;
}

/** Phonemizes to lowercase letters and returns 100 samples per token. */
function layerFakeEngine(options: FakeEngineOptions = {}) {
  return Layer.succeed(
    KokoroEngine.KokoroEngine,
    KokoroEngine.KokoroEngine.of({
      acquire: ({ onDownloadProgress }) =>
        Effect.gen(function* () {
          for (const [completed, total] of options.downloadProgress ?? []) {
            yield* onDownloadProgress(completed, total);
          }
          yield* options.onAcquire ?? Effect.void;
          return {
            vocab,
            phonemize: (text) => Effect.succeed([text.toLowerCase().replace(/[^a-z ]/g, "")]),
            infer: (ids) =>
              (options.onInfer?.(ids) ?? Effect.void).pipe(
                Effect.as(new Float32Array((ids.length - 2) * 100).fill(0.5)),
              ),
          };
        }),
    }),
  );
}

const synthesize = (text: string) =>
  Effect.gen(function* () {
    const speech = yield* SpeechSynthesis.SpeechSynthesis;
    return yield* speech.synthesize({ text, voice: "af_heart" }).pipe(Stream.runCollect);
  });

const summarize = (events: ReadonlyArray<SpeechSynthesisEvent>) =>
  events.map((event) =>
    event.type === "chunk"
      ? `chunk ${event.durationSeconds * KOKORO_SAMPLE_RATE}`
      : `${event.stage} ${event.completed}/${event.total}`,
  );

describe("SpeechSynthesis", () => {
  it.effect("streams one WAV chunk per sentence after its progress event", () =>
    Effect.gen(function* () {
      const events = yield* synthesize("Hi you. Bye!");
      expect(summarize(events)).toEqual([
        "starting 0/null",
        "generating 0/2",
        // "hi you." keeps its period: 7 tokens of 100 samples.
        "chunk 700",
        "generating 1/2",
        "chunk 400",
      ]);
      const chunk = events.find((event) => event.type === "chunk");
      expect(chunk?.type === "chunk" && new TextDecoder().decode(chunk.audio.subarray(0, 4))).toBe(
        "RIFF",
      );
    }).pipe(Effect.provide(SpeechSynthesis.layer.pipe(Layer.provide(layerFakeEngine())))),
  );

  it.effect("reports model download progress before generating", () =>
    Effect.gen(function* () {
      const events = yield* synthesize("Hi.");
      expect(summarize(events).slice(0, 3)).toEqual([
        "starting 0/null",
        "downloading-model 10/100",
        "downloading-model 100/100",
      ]);
    }).pipe(
      Effect.provide(
        SpeechSynthesis.layer.pipe(
          Layer.provide(
            layerFakeEngine({
              downloadProgress: [
                [10, 100],
                [100, 100],
              ],
            }),
          ),
        ),
      ),
    ),
  );

  it.effect("skips text with nothing to pronounce", () =>
    Effect.gen(function* () {
      const events = yield* synthesize("Hello. 123 ---");
      expect(summarize(events).filter((line) => line.startsWith("chunk"))).toEqual(["chunk 600"]);
    }).pipe(Effect.provide(SpeechSynthesis.layer.pipe(Layer.provide(layerFakeEngine())))),
  );

  it.effect("fails the stream when the engine fails", () =>
    Effect.gen(function* () {
      const error = yield* synthesize("Hello.").pipe(Effect.flip);
      expect(error).toBeInstanceOf(KokoroEngine.SpeechEngineError);
    }).pipe(
      Effect.provide(
        SpeechSynthesis.layer.pipe(
          Layer.provide(
            layerFakeEngine({
              onInfer: () =>
                Effect.fail(new KokoroEngine.SpeechEngineError({ operation: "infer" })),
            }),
          ),
        ),
      ),
    ),
  );

  it.effect("runs one synthesis at a time on a host", () => {
    const firstInferring = Deferred.makeUnsafe<void>();
    const releaseFirst = Deferred.makeUnsafe<void>();
    const log: string[] = [];
    return Effect.gen(function* () {
      const first = yield* synthesize("First.").pipe(
        Effect.andThen(Effect.sync(() => log.push("first done"))),
        Effect.forkChild,
      );
      yield* Deferred.await(firstInferring);
      const second = yield* synthesize("Second.").pipe(Effect.forkChild);
      // Without the permit, the second request would reach the engine within these turns.
      yield* Effect.repeat(Effect.yieldNow, { times: 20 });
      yield* Deferred.succeed(releaseFirst, undefined);
      yield* Fiber.join(first);
      yield* Fiber.join(second);
      expect(log).toEqual(["acquire", "first done", "acquire"]);
    }).pipe(
      Effect.provide(
        SpeechSynthesis.layer.pipe(
          Layer.provide(
            layerFakeEngine({
              onAcquire: Effect.sync(() => log.push("acquire")),
              onInfer: () =>
                log.length === 1
                  ? Deferred.succeed(firstInferring, undefined).pipe(
                      Effect.andThen(Deferred.await(releaseFirst)),
                    )
                  : Effect.void,
            }),
          ),
        ),
      ),
    );
  });
});
