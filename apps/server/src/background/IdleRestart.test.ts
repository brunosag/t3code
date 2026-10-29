import { describe, expect, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import * as IdleRestart from "./IdleRestart.ts";

const start = Effect.fn(function* (initial: {
  readonly pending: string | undefined;
  readonly idleSince: number | undefined;
}) {
  const pending = yield* Ref.make(initial.pending);
  const idleSince = yield* Ref.make(initial.idleSince);
  const restarts = yield* Ref.make(0);
  yield* Effect.forkScoped(
    IdleRestart.run({
      pendingVersion: Ref.get(pending),
      idleSince: Ref.get(idleSince),
      restart: Ref.update(restarts, (count) => count + 1).pipe(Effect.as(true)),
    }),
  );
  return { pending, idleSince, restarts: Ref.get(restarts) };
});

describe("IdleRestart", () => {
  it.effect("restarts once agent work has been idle for two minutes", () =>
    Effect.gen(function* () {
      const service = yield* start({ pending: "2.0.0", idleSince: 0 });
      yield* TestClock.adjust(Duration.minutes(1));
      expect(yield* service.restarts).toBe(0);
      yield* TestClock.adjust(Duration.minutes(1));
      expect(yield* service.restarts).toBe(1);
      yield* TestClock.adjust(Duration.hours(1));
      expect(yield* service.restarts).toBe(1);
    }).pipe(Effect.scoped),
  );

  it.effect("waits for running agent work to finish", () =>
    Effect.gen(function* () {
      const service = yield* start({ pending: "2.0.0", idleSince: undefined });
      yield* TestClock.adjust(Duration.minutes(10));
      expect(yield* service.restarts).toBe(0);
      yield* Ref.set(service.idleSince, Duration.toMillis(Duration.minutes(10)));
      yield* TestClock.adjust(Duration.minutes(1));
      expect(yield* service.restarts).toBe(0);
      yield* TestClock.adjust(Duration.minutes(1));
      expect(yield* service.restarts).toBe(1);
    }).pipe(Effect.scoped),
  );

  it.effect("restarts 12 hours after first seeing the version even while work runs", () =>
    Effect.gen(function* () {
      const service = yield* start({ pending: undefined, idleSince: undefined });
      yield* TestClock.adjust(Duration.hours(1));
      // First seen by the check at 1h01m, so the deadline is 13h01m, not 12h.
      yield* Ref.set(service.pending, "2.0.0");
      yield* TestClock.adjust(Duration.hours(12));
      expect(yield* service.restarts).toBe(0);
      yield* TestClock.adjust(Duration.minutes(1));
      expect(yield* service.restarts).toBe(1);
    }).pipe(Effect.scoped),
  );

  it.effect("never restarts without a pending version", () =>
    Effect.gen(function* () {
      const service = yield* start({ pending: undefined, idleSince: 0 });
      yield* TestClock.adjust(Duration.hours(13));
      expect(yield* service.restarts).toBe(0);
    }).pipe(Effect.scoped),
  );
});
