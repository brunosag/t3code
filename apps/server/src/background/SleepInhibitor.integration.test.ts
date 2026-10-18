import { expect, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  NodeId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2TurnItem,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as SleepInhibitor from "./SleepInhibitor.ts";

const layer = ProjectionStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory));

it.layer(layer)("SleepInhibitor persisted work", (it) => {
  it.effect.each([
    ["codex", "command"],
    ["codex", "subagent"],
    ["claudeAgent", "command"],
    ["claudeAgent", "monitor"],
  ] as const)("keeps %s %s work awake after its parent run completes", ([provider, kind]) =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const now = DateTime.makeUnsafe("2026-10-18T12:00:00Z");
      const threadId = ThreadId.make(`${provider}-${kind}`);
      const runId = RunId.make(`run:${threadId}`);
      const providerThreadId = ProviderThreadId.make(`provider-thread:${threadId}`);
      const providerInstanceId = ProviderInstanceId.make(provider);
      const driver = ProviderDriverKind.make(provider);
      const modelSelection = { instanceId: providerInstanceId, model: "test-model" };
      const base = { threadId, driver, providerInstanceId, occurredAt: now };
      yield* store.apply({
        ...base,
        id: EventId.make(`thread:${threadId}`),
        type: "thread.created",
        payload: {
          id: threadId,
          projectId: ProjectId.make("sleep-inhibitor"),
          title: `${provider} background ${kind}`,
          createdBy: "user",
          creationSource: "web",
          providerInstanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: providerThreadId,
          lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
      });
      const run = {
        id: runId,
        threadId,
        ordinal: 1,
        providerInstanceId,
        modelSelection,
        providerThreadId,
        userMessageId: MessageId.make(`message:${threadId}`),
        rootNodeId: null,
        activeAttemptId: null,
        status: "running" as const,
        requestedAt: now,
        startedAt: now,
        completedAt: null,
        checkpointId: null,
        contextHandoffId: null,
      };
      yield* store.apply({
        ...base,
        id: EventId.make(`run:${threadId}`),
        type: "run.created",
        payload: run,
      });

      const providerThread: OrchestrationV2ProviderThread = {
        id: providerThreadId,
        driver,
        providerInstanceId,
        providerSessionId: null,
        appThreadId: threadId,
        ownerNodeId: null,
        nativeThreadRef: null,
        nativeConversationHeadRef: null,
        status: "idle",
        firstRunOrdinal: 1,
        lastRunOrdinal: 1,
        handoffIds: [],
        forkedFrom: null,
        pendingBackgroundTasks: [{ taskId: "native-task", kind }],
        createdAt: now,
        updatedAt: now,
      };
      const item: OrchestrationV2TurnItem = {
        id: TurnItemId.make(`item:${threadId}`),
        threadId,
        runId,
        nodeId: null,
        providerThreadId,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 1,
        status: "running",
        title: "Background work",
        startedAt: now,
        completedAt: null,
        updatedAt: now,
        ...(kind === "subagent"
          ? {
              type: "subagent",
              subagentId: NodeId.make(`subagent:${threadId}`),
              origin: "provider_native",
              driver,
              providerInstanceId,
              childThreadId: null,
              prompt: "Review the change",
              result: null,
            }
          : { type: "command_execution", input: "long-running-command" }),
      };
      const workEvent: OrchestrationV2DomainEvent =
        provider === "codex"
          ? {
              ...base,
              id: EventId.make(`work:${threadId}`),
              type: "turn-item.updated",
              payload: item,
            }
          : {
              ...base,
              id: EventId.make(`work:${threadId}`),
              type: "provider-thread.updated",
              payload: providerThread,
            };
      yield* store.apply(workEvent);
      const finishedEvent: OrchestrationV2DomainEvent =
        workEvent.type === "turn-item.updated"
          ? {
              ...workEvent,
              id: EventId.make(`finished:${threadId}`),
              payload: { ...workEvent.payload, status: "completed", completedAt: now },
            }
          : {
              ...base,
              id: EventId.make(`finished:${threadId}`),
              type: "provider-thread.updated",
              payload: { ...providerThread, pendingBackgroundTasks: [] },
            };
      const events: ReadonlyArray<OrchestrationV2DomainEvent> = [
        {
          ...base,
          id: EventId.make(`completed:${threadId}`),
          type: "run.updated",
          payload: { ...run, status: "completed", completedAt: now },
        },
        finishedEvent,
      ];
      const snapshot = yield* store.getShellSnapshot();
      const log: Array<string> = [];
      yield* SleepInhibitor.run({
        initialThreads: snapshot.threads,
        events: Stream.fromIterable(events).pipe(
          Stream.flatMap((event) =>
            Stream.fromEffect(
              Effect.gen(function* () {
                expect(log).toEqual(["acquire"]);
                yield* store.apply(event);
                return event;
              }),
            ),
          ),
        ),
        getThreadShell: (id) => store.getThreadShell(id).pipe(Effect.orDie),
        holdLock: Effect.acquireRelease(
          Effect.sync(() => log.push("acquire")),
          () => Effect.sync(() => log.push("release")),
        ).pipe(Effect.andThen(Effect.never)),
      });
      expect(log).toEqual(["acquire", "release"]);
    }).pipe(Effect.scoped),
  );
});
