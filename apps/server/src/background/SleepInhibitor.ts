// logind ignores sleep locks on lid close unless handle-lid-switch is also inhibited.
// Other platforms use a no-op layer.
import type {
  OrchestrationV2DomainEvent,
  OrchestrationV2ThreadShell,
  ThreadId,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  isBackgroundTurnItem,
  isPullRequestWatchTask,
} from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
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
  "--why=Agent work is running",
  "--mode=block",
  // `cat` reads the server's stdin pipe, so the lock also drops if the
  // server dies without running finalizers.
  "cat",
];

type ThreadActivity = Pick<
  OrchestrationV2ThreadShell,
  "id" | "activityRunStatus" | "pendingBackgroundTasks"
>;

const isThreadActive = (thread: ThreadActivity | null) =>
  thread?.activityRunStatus != null ||
  // PR watches are passive server polling; provider Monitor tasks still own running processes.
  (thread?.pendingBackgroundTasks ?? []).some((task) => !isPullRequestWatchTask(task));

/**
 * Runs `holdLock` while at least one thread is active. Work and deletion
 * events re-read the thread through `getThreadShell`, so stale events cannot
 * pin the lock. `holdLock` should keep the lock until it is interrupted.
 */
export const run = Effect.fn("SleepInhibitor.run")(function* <E>(input: {
  readonly initialThreads: Iterable<ThreadActivity>;
  readonly events: Stream.Stream<OrchestrationV2DomainEvent, E>;
  readonly getThreadShell: (threadId: ThreadId) => Effect.Effect<ThreadActivity | null>;
  readonly holdLock: Effect.Effect<void, never, Scope.Scope>;
}) {
  const activeThreadIds = new Set(
    Array.from(input.initialThreads)
      .filter(isThreadActive)
      .map((thread) => thread.id),
  );
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
        case "provider-thread.updated":
        case "thread.provider-switched":
        case "thread.deleted":
          break;
        case "turn-item.updated":
          if (!isBackgroundTurnItem(event.payload)) return;
          break;
        default:
          return;
      }
      if (isThreadActive(yield* input.getThreadShell(event.threadId))) {
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
  yield* Effect.logWarning("systemd-inhibit exited while agent work was running", { exitCode });
}).pipe(
  Effect.catch((error) => Effect.logWarning("failed to hold sleep inhibitor lock", { error })),
);

/** Runs `holdLock` in the background while any thread has unfinished agent work. */
export const watchAgentWork = Effect.fn("SleepInhibitor.watchAgentWork")(function* (
  name: string,
  holdLock: Effect.Effect<void, never, Scope.Scope>,
) {
  const threads = yield* ThreadManagement.ThreadManagementService;
  yield* forkParked(
    Effect.gen(function* () {
      const snapshot = yield* threads.getShellSnapshot();
      // Resume right after the snapshot so no run transition is missed.
      yield* run({
        initialThreads: snapshot.threads,
        events: threads
          .streamStoredEventsFrom({ afterSequence: snapshot.snapshotSequence })
          .pipe(Stream.map((stored) => stored.event)),
        getThreadShell: (threadId) =>
          threads.getThreadShell(threadId).pipe(Effect.orElseSucceed(() => null)),
        holdLock,
      });
    }).pipe(
      // The lock lives in this scope, so it drops if the event stream fails.
      Effect.scoped,
      Effect.catch((error) => Effect.logWarning(`${name} stopped`, { error })),
    ),
  );
});

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    if ((yield* HostProcess.Platform) !== "linux") {
      return;
    }
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    yield* watchAgentWork(
      "sleep inhibitor",
      holdSystemdInhibitLock.pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      ),
    );
  }),
);
