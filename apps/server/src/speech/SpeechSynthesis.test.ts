import { describe, expect, it } from "@effect/vitest";
import type { SpeechSynthesisEvent } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as PhononEngine from "./PhononEngine.ts";
import * as ReadAloudScript from "./readAloudScript.ts";
import { SPEECH_SAMPLE_RATE } from "./speechText.ts";
import * as SpeechSynthesis from "./SpeechSynthesis.ts";

interface FakeEngineOptions {
  readonly onAcquire?: Effect.Effect<void>;
  readonly onSpeak?: (text: string) => Effect.Effect<void, PhononEngine.SpeechEngineError>;
  readonly downloadProgress?: ReadonlyArray<readonly [number, number]>;
  readonly write?: ReadAloudScript.ReadAloudScript["Service"]["write"];
}

/**
 * Speaks 100 samples per letter or sentence mark, so digits and dashes yield no audio. Without
 * `write`, no read aloud model is set.
 */
function layerFakes(options: FakeEngineOptions = {}) {
  const script = Layer.succeed(
    ReadAloudScript.ReadAloudScript,
    ReadAloudScript.ReadAloudScript.of({ write: options.write ?? (() => Effect.succeed(null)) }),
  );
  const engine = Layer.succeed(
    PhononEngine.PhononEngine,
    PhononEngine.PhononEngine.of({
      acquire: ({ onDownloadProgress }) =>
        Effect.gen(function* () {
          for (const [completed, total] of options.downloadProgress ?? []) {
            yield* onDownloadProgress(completed, total);
          }
          yield* options.onAcquire ?? Effect.void;
          return {
            speak: (text) =>
              (options.onSpeak?.(text) ?? Effect.void).pipe(
                Effect.as(
                  new Float32Array((text.match(/[\p{L}.!?]/gu)?.length ?? 0) * 100).fill(0.5),
                ),
              ),
          };
        }),
    }),
  );
  return Layer.merge(engine, script);
}

const synthesize = (text: string, markdown?: string) =>
  Effect.gen(function* () {
    const speech = yield* SpeechSynthesis.SpeechSynthesis;
    return yield* speech
      .synthesize({ text, ...(markdown === undefined ? {} : { markdown }), voice: "default" })
      .pipe(Stream.runCollect);
  });

const summarize = (events: ReadonlyArray<SpeechSynthesisEvent>) =>
  events.map((event) =>
    event.type === "chunk"
      ? `chunk ${event.durationSeconds * SPEECH_SAMPLE_RATE}`
      : `${event.stage} ${event.completed}/${event.total}`,
  );

describe("SpeechSynthesis", () => {
  it.effect("streams one WAV chunk per sentence after its progress event", () =>
    Effect.gen(function* () {
      const events = yield* synthesize("Hi you. Bye!");
      expect(summarize(events)).toEqual([
        "starting 0/null",
        "generating 0/2",
        // Five letters and the period.
        "chunk 600",
        "generating 1/2",
        "chunk 400",
      ]);
      const chunk = events.find((event) => event.type === "chunk");
      expect(chunk?.type === "chunk" && new TextDecoder().decode(chunk.audio.subarray(0, 4))).toBe(
        "RIFF",
      );
    }).pipe(Effect.provide(SpeechSynthesis.layer.pipe(Layer.provide(layerFakes())))),
  );

  it.effect("speaks the reply as the read aloud model rewrites it, or the text without one", () => {
    const spoken: string[] = [];
    const layer = (written: string | null) =>
      SpeechSynthesis.layer.pipe(
        Layer.provide(
          layerFakes({
            onSpeak: (text) => Effect.sync(() => spoken.push(text)),
            write: (markdown, onWriting) =>
              written === null
                ? Effect.succeed(null)
                : onWriting.pipe(Effect.as(`${written}, from ${markdown.length} characters.`)),
          }),
        ),
      );
    return Effect.gen(function* () {
      const rewritten = yield* synthesize("Run vp i.", "Run `vp i`.").pipe(
        Effect.provide(layer("Run V P install")),
      );
      expect(summarize(rewritten).slice(0, 3)).toEqual([
        "wording 0/null",
        "starting 0/null",
        "generating 0/1",
      ]);
      yield* synthesize("Run vp i.", "Run `vp i`.").pipe(Effect.provide(layer(null)));
      expect(spoken).toEqual(["Run V P install, from 11 characters.", "Run vp i."]);
    });
  });

  it.effect("estimates the whole response at the rate of the audio generated so far", () =>
    Effect.gen(function* () {
      const events = yield* synthesize("Hi you. Bye now. Ok.");
      const estimates = events.flatMap((event) =>
        event.type === "progress" && event.stage === "generating"
          ? [event.estimatedDurationSeconds]
          : [],
      );
      // "Hi you." is 7 characters in 600 samples; "Bye now. Ok." follows at that rate.
      expect(estimates[0]).toBeUndefined();
      expect(estimates[1]).toBeCloseTo((600 / SPEECH_SAMPLE_RATE) * (1 + 12 / 7));
    }).pipe(Effect.provide(SpeechSynthesis.layer.pipe(Layer.provide(layerFakes())))),
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
            layerFakes({
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
    }).pipe(Effect.provide(SpeechSynthesis.layer.pipe(Layer.provide(layerFakes())))),
  );

  it.effect("fails the stream when the engine fails", () =>
    Effect.gen(function* () {
      const error = yield* synthesize("Hello.").pipe(Effect.flip);
      expect(error).toBeInstanceOf(PhononEngine.SpeechEngineError);
    }).pipe(
      Effect.provide(
        SpeechSynthesis.layer.pipe(
          Layer.provide(
            layerFakes({
              onSpeak: () =>
                Effect.fail(new PhononEngine.SpeechEngineError({ operation: "speak" })),
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
            layerFakes({
              onAcquire: Effect.sync(() => log.push("acquire")),
              onSpeak: () =>
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
