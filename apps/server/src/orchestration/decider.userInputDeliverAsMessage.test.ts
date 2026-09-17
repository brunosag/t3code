import {
  ApprovalRequestId,
  CommandId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationReadModel,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";
import { projectEvent } from "./projector.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const threadId = ThreadId.make("thread-1");
const requestId = ApprovalRequestId.make("question-1");

/** A native callback question: no `responseMode`, so the provider is blocked. */
function makeRequest(
  questions?: ReadonlyArray<Record<string, unknown>>,
): OrchestrationThreadActivity {
  return {
    id: EventId.make(requestId),
    kind: "user-input.requested",
    summary: "Question",
    tone: "approval",
    turnId: null,
    createdAt: NOW,
    payload: {
      requestId,
      questions: questions ?? [
        { id: "0", header: "Q", question: "Continue?", options: [], multiSelect: true },
      ],
    },
  };
}

function makeReadModel(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [],
    threads: [
      {
        id: threadId,
        projectId: ProjectId.make("project-1"),
        title: "Thread",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
        pullRequests: [],
        branch: null,
        worktreePath: null,
        latestTurn: null,
        createdAt: NOW,
        updatedAt: NOW,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        snoozedUntil: null,
        snoozedAt: null,
        pinnedAt: null,
        deletedAt: null,
        messages: [],
        proposedPlans: [],
        activities: [...activities],
        checkpoints: [],
        session: null,
      },
    ],
    updatedAt: NOW,
  };
}

function makeCommand(deliverAsMessage: boolean) {
  return {
    type: "thread.user-input.respond" as const,
    commandId: CommandId.make("respond-1"),
    threadId,
    requestId,
    answers: { "0": ["Node.js", "Go"] },
    ...(deliverAsMessage ? { deliverAsMessage: true } : {}),
    createdAt: NOW,
  };
}

it.layer(NodeServices.layer)("user input deliver-as-message decider", (it) => {
  it.effect("delivers a dead callback's answers as a message", () =>
    Effect.gen(function* () {
      const request = makeRequest();
      const readModel = makeReadModel([request]);
      const result = yield* decideOrchestrationCommand({
        command: makeCommand(true),
        readModel,
        userInputActivity: request,
      });
      const events = Array.isArray(result) ? result : [result];

      expect(events.map((event) => event.type)).toEqual([
        "thread.activity-appended",
        "thread.message-sent",
        "thread.turn-start-requested",
      ]);
      expect(events[0]?.payload).toMatchObject({
        threadId,
        activity: {
          kind: "user-input.resolved",
          payload: { requestId, answers: { "0": ["Node.js", "Go"] } },
        },
      });
      // The answers reach the agent as a user message, array answers included.
      expect(events[1]?.payload).toMatchObject({
        threadId,
        role: "user",
        text: "Continue?\nNode.js, Go",
      });

      const projected = yield* projectEvent(readModel, { ...events[0]!, sequence: 1 });
      expect(
        projected.threads[0]?.activities.some(
          (activity) =>
            activity.kind === "user-input.resolved" &&
            typeof activity.payload === "object" &&
            activity.payload !== null &&
            (activity.payload as Record<string, unknown>).requestId === requestId,
        ),
      ).toBe(true);
    }),
  );

  it.effect("keeps the provider callback path for a live question", () =>
    Effect.gen(function* () {
      const request = makeRequest();
      const result = yield* decideOrchestrationCommand({
        command: makeCommand(false),
        readModel: makeReadModel([request]),
        userInputActivity: request,
      });
      const events = Array.isArray(result) ? result : [result];
      expect(events.map((event) => event.type)).toEqual(["thread.user-input-response-requested"]);
    }),
  );

  it.effect("delivers answers under their question ids when the payload is gone", () =>
    Effect.gen(function* () {
      const request = makeRequest([]);
      const result = yield* decideOrchestrationCommand({
        command: makeCommand(true),
        readModel: makeReadModel([request]),
        userInputActivity: request,
      });
      const events = Array.isArray(result) ? result : [result];
      expect(events[1]?.payload).toMatchObject({
        role: "user",
        text: "0: Node.js, Go",
      });
    }),
  );
});
