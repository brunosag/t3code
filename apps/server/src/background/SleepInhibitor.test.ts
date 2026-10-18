import {
  type OrchestrationV2DomainEvent,
  type OrchestrationV2PendingBackgroundTask,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import * as SleepInhibitor from "./SleepInhibitor.ts";

const thread = ThreadId.make;

const shell = (id: string, active: boolean) => ({
  id: thread(id),
  activityRunStatus: active ? ("running" as const) : null,
  pendingBackgroundTasks: [],
});

const backgroundShell = (kind: OrchestrationV2PendingBackgroundTask["kind"]) => ({
  ...shell("a", false),
  pendingBackgroundTasks: [{ taskId: "background-work", kind }],
});

const turnItemEvent = (type: string) =>
  ({ ...event("turn-item.updated", "a"), payload: { type } }) as OrchestrationV2DomainEvent;

const holdLock = (log: Array<string>) =>
  Effect.acquireRelease(
    Effect.sync(() => log.push("acquire")),
    () => Effect.sync(() => log.push("release")),
  ).pipe(Effect.andThen(Effect.never));

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
        initialThreads: [shell("a", true)],
        events: Stream.fromIterable([
          event("run.created", "b"),
          event("run.updated", "a"),
          event("message.updated", "c"),
          event("run.updated", "a"),
          event("thread.deleted", "b"),
          event("run.created", "c"),
          event("run.updated", "c"),
        ]),
        getThreadShell: (threadId) =>
          Effect.sync(() => {
            const [expected, active] = states.shift()!;
            expect(threadId).toBe(expected);
            return shell(expected, active);
          }),
        holdLock: holdLock(log),
      });

      expect(states).toEqual([]);
      expect(log).toEqual(["acquire", "release", "acquire", "release"]);
    }).pipe(Effect.scoped),
  );

  it.effect("keeps the lock after the parent completes until its background command finishes", () =>
    Effect.gen(function* () {
      const log: Array<string> = [];
      const states = [backgroundShell("command"), shell("a", false)];

      yield* SleepInhibitor.run({
        initialThreads: [shell("a", true)],
        events: Stream.fromIterable([
          event("run.updated", "a"),
          turnItemEvent("command_execution"),
        ]),
        getThreadShell: () =>
          Effect.sync(() => {
            expect(log).toEqual(["acquire"]);
            return states.shift()!;
          }),
        holdLock: holdLock(log),
      });

      expect(states).toEqual([]);
      expect(log).toEqual(["acquire", "release"]);
    }).pipe(Effect.scoped),
  );

  it.effect.each(["preparing", "starting", "running", "waiting"] as const)(
    "keeps a %s run awake until it completes",
    (activityRunStatus) =>
      Effect.gen(function* () {
        const log: Array<string> = [];
        yield* SleepInhibitor.run({
          initialThreads: [{ ...shell("a", true), activityRunStatus }],
          events: Stream.make(event("run.updated", "a")),
          getThreadShell: () =>
            Effect.sync(() => {
              expect(log).toEqual(["acquire"]);
              return shell("a", false);
            }),
          holdLock: holdLock(log),
        });
        expect(log).toEqual(["acquire", "release"]);
      }).pipe(Effect.scoped),
  );

  it.effect("releases the lock when the thread with background work is deleted", () =>
    Effect.gen(function* () {
      const log: Array<string> = [];
      yield* SleepInhibitor.run({
        initialThreads: [backgroundShell("command")],
        events: Stream.make(event("thread.deleted", "a")),
        getThreadShell: () => Effect.succeed(null),
        holdLock: holdLock(log),
      });
      expect(log).toEqual(["acquire", "release"]);
    }).pipe(Effect.scoped),
  );

  it.effect.each(["command", "subagent", "monitor", "background_task"] as const)(
    "holds the lock for a %s already pending at startup and releases when its roster clears",
    (kind) =>
      Effect.gen(function* () {
        const log: Array<string> = [];
        yield* SleepInhibitor.run({
          initialThreads: [backgroundShell(kind)],
          events: Stream.make(event("provider-thread.updated", "a")),
          getThreadShell: () =>
            Effect.sync(() => {
              expect(log).toEqual(["acquire"]);
              return shell("a", false);
            }),
          holdLock: holdLock(log),
        });
        expect(log).toEqual(["acquire", "release"]);
      }).pipe(Effect.scoped),
  );

  it.effect.each(["provider-thread.updated", "thread.provider-switched"] as const)(
    "acquires and releases the lock for late background work on %s",
    (type) =>
      Effect.gen(function* () {
        const log: Array<string> = [];
        const states = [backgroundShell("command"), shell("a", false)];
        yield* SleepInhibitor.run({
          initialThreads: [shell("a", false)],
          events: Stream.make(event(type, "a"), event(type, "a")),
          getThreadShell: () => Effect.sync(() => states.shift()!),
          holdLock: holdLock(log),
        });
        expect(states).toEqual([]);
        expect(log).toEqual(["acquire", "release"]);
      }).pipe(Effect.scoped),
  );

  it.effect.each(["command_execution", "subagent", "dynamic_tool"] as const)(
    "tracks a background %s through start, waiting, and completion",
    (type) =>
      Effect.gen(function* () {
        const log: Array<string> = [];
        const states = [
          backgroundShell("subagent"),
          backgroundShell("subagent"),
          shell("a", false),
        ];
        yield* SleepInhibitor.run({
          initialThreads: [shell("a", false)],
          events: Stream.make(turnItemEvent(type), turnItemEvent(type), turnItemEvent(type)),
          getThreadShell: () => Effect.sync(() => states.shift()!),
          holdLock: holdLock(log),
        });
        expect(states).toEqual([]);
        expect(log).toEqual(["acquire", "release"]);
      }).pipe(Effect.scoped),
  );

  it.effect("does not acquire a lock for a passive pull request watch", () =>
    Effect.gen(function* () {
      const log: Array<string> = [];
      yield* SleepInhibitor.run({
        initialThreads: [
          {
            ...shell("a", false),
            pendingBackgroundTasks: [
              { kind: "monitor", taskId: "pull-request-watch:github.com/acme/app#1" },
            ],
          },
        ],
        events: Stream.empty,
        getThreadShell: () => Effect.die("no event should read a thread"),
        holdLock: holdLock(log),
      });
      expect(log).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("ignores transcript updates unrelated to background work", () =>
    Effect.gen(function* () {
      const log: Array<string> = [];
      yield* SleepInhibitor.run({
        initialThreads: [],
        events: Stream.make(event("message.updated", "a"), turnItemEvent("assistant_message")),
        getThreadShell: () => Effect.die("transcript updates must not query the shell"),
        holdLock: holdLock(log),
      });
      expect(log).toEqual([]);
    }).pipe(Effect.scoped),
  );
});
