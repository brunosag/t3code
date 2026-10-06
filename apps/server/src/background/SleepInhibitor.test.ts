import type { OrchestrationV2DomainEvent, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import * as SleepInhibitor from "./SleepInhibitor.ts";

const thread = (id: string) => id as ThreadId;

const event = (type: OrchestrationV2DomainEvent["type"], threadId: string) =>
  ({ type, threadId }) as unknown as OrchestrationV2DomainEvent;

describe("SleepInhibitor", () => {
  it.effect("holds one lock while any thread is active", () =>
    Effect.gen(function* () {
      const log: Array<string> = [];
      // Each event flips the thread to the state the next read should see.
      const states: Array<[string, boolean]> = [
        ["b", true],
        ["a", false],
        ["a", false],
        ["b", false],
        ["c", true],
        ["c", false],
      ];

      yield* SleepInhibitor.run({
        initialActiveThreadIds: [thread("a")],
        events: Stream.fromIterable([
          event("run.created", "b"),
          event("run.updated", "a"),
          event("message.updated", "c"),
          event("run.updated", "a"),
          event("thread.deleted", "b"),
          event("run.created", "c"),
          event("run.updated", "c"),
        ]),
        isThreadActive: (threadId) =>
          Effect.sync(() => {
            const [expected, active] = states.shift()!;
            expect(threadId).toBe(expected);
            return active;
          }),
        holdLock: Effect.acquireRelease(
          Effect.sync(() => log.push("acquire")),
          () => Effect.sync(() => log.push("release")),
        ).pipe(Effect.andThen(Effect.never)),
      });

      expect(states).toEqual([]);
      expect(log).toEqual(["acquire", "release", "acquire", "release"]);
    }).pipe(Effect.scoped),
  );
});
