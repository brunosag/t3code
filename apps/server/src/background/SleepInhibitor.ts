/**
 * SleepInhibitor - keeps a Linux host awake while any thread has an active
 * run, by holding a logind block lock through `systemd-inhibit`.
 *
 * The lock includes `handle-lid-switch` because logind ignores plain sleep
 * locks for lid-close suspend by default (`LidSwitchIgnoreInhibited=yes`).
 * Other platforms get a no-op layer.
 *
 * @module SleepInhibitor
 */
import type { OrchestrationV2DomainEvent, ThreadId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { forkParked } from "../serverActivation.ts";

const SYSTEMD_INHIBIT_ARGS = [
  "--what=sleep:idle:handle-lid-switch",
  "--who=T3 Code",
  "--why=An agent turn is running",
  "--mode=block",
  // `cat` reads the server's stdin pipe, so the lock also drops if the
  // server dies without running finalizers.
  "cat",
];

/**
 * Runs `holdLock` while at least one thread is active. Run and deletion
 * events re-read the thread through `isThreadActive`, so stale events cannot
 * pin the lock. `holdLock` should keep the lock until it is interrupted.
 */
export const run = <E>(input: {
  readonly initialActiveThreadIds: Iterable<ThreadId>;
  readonly events: Stream.Stream<OrchestrationV2DomainEvent, E>;
  readonly isThreadActive: (threadId: ThreadId) => Effect.Effect<boolean>;
  readonly holdLock: Effect.Effect<void, never, Scope.Scope>;
}) =>
  Effect.gen(function* () {
    const activeThreadIds = new Set(input.initialActiveThreadIds);
    let lock: Fiber.Fiber<void> | null = null;

    const sync = Effect.gen(function* () {
      if (activeThreadIds.size > 0 && lock === null) {
        lock = yield* Effect.forkScoped(Effect.scoped(input.holdLock), {
          startImmediately: true,
        });
      } else if (activeThreadIds.size === 0 && lock !== null) {
        yield* Fiber.interrupt(lock);
        lock = null;
      }
    });

    yield* sync;
    yield* Stream.runForEach(input.events, (event) =>
      Effect.gen(function* () {
        switch (event.type) {
          case "run.created":
          case "run.updated":
          case "thread.deleted":
            break;
          default:
            return;
        }
        if (yield* input.isThreadActive(event.threadId)) {
          activeThreadIds.add(event.threadId);
        } else {
          activeThreadIds.delete(event.threadId);
        }
        yield* sync;
      }),
    );
  });

const holdSystemdInhibitLock = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  // Detached so scope cleanup kills the whole group, including `cat`.
  const child = yield* spawner.spawn(
    ChildProcess.make("systemd-inhibit", SYSTEMD_INHIBIT_ARGS, {
      detached: true,
      stdin: "pipe",
      stdout: "ignore",
      stderr: "ignore",
    }),
  );
  const exitCode = yield* child.exitCode;
  yield* Effect.logWarning("systemd-inhibit exited while a turn was running", { exitCode });
}).pipe(
  Effect.catch((error) => Effect.logWarning("failed to hold sleep inhibitor lock", { error })),
);

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    if ((yield* HostProcess.Platform) !== "linux") {
      return;
    }
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const threads = yield* ThreadManagement.ThreadManagementService;

    yield* forkParked(
      Effect.gen(function* () {
        const snapshot = yield* threads.getShellSnapshot();
        // Resume right after the snapshot so no run transition is missed.
        yield* run({
          initialActiveThreadIds: snapshot.threads
            .filter((thread) => thread.activityRunStatus != null)
            .map((thread) => thread.id),
          events: threads
            .streamStoredEventsFrom({ afterSequence: snapshot.snapshotSequence })
            .pipe(Stream.map((stored) => stored.event)),
          isThreadActive: (threadId) =>
            threads.getThreadShell(threadId).pipe(
              Effect.map((shell) => shell?.activityRunStatus != null),
              Effect.orElseSucceed(() => false),
            ),
          holdLock: holdSystemdInhibitLock.pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          ),
        });
      }).pipe(
        // The lock lives in this scope, so it drops if the event stream fails.
        Effect.scoped,
        Effect.catch((error) => Effect.logWarning("sleep inhibitor stopped", { error })),
      ),
    );
  }),
);
