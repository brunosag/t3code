import { describe, expect, it } from "@effect/vitest";
import {
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { idleCompactionWindow, type IdleCompactionRecords } from "./IdleCompaction.ts";

const NOW_MS = Date.parse("2026-10-19T12:00:00.000Z");
const MINUTE_MS = 60_000;
const at = (offset = 0) => DateTime.makeUnsafe(NOW_MS + offset);
const threadId = ThreadId.make("idle-thread");
const runId = RunId.make("run-1");
const instanceId = ProviderInstanceId.make("claudeAgent");
const providerThreadId = ProviderThreadId.make("provider-thread");
const modelSelection = { instanceId, model: "claude-opus-5-5" };

function records(
  usage: { readonly usedTokens?: number; readonly cacheExpiresInMs?: number } = {},
): { -readonly [Key in keyof IdleCompactionRecords]: IdleCompactionRecords[Key] } {
  const messageId = MessageId.make("message-1");
  const nodeId = NodeId.make("root-node");
  return {
    thread: {
      id: threadId,
      projectId: ProjectId.make("project"),
      title: "Idle thread",
      createdBy: "user",
      creationSource: "web",
      providerInstanceId: instanceId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: providerThreadId,
      lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
      forkedFrom: null,
      createdAt: at(-MINUTE_MS),
      updatedAt: at(),
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: at(),
      deletedAt: null,
    },
    runs: [
      {
        id: runId,
        threadId,
        ordinal: 1,
        providerInstanceId: instanceId,
        modelSelection,
        providerThreadId,
        userMessageId: messageId,
        rootNodeId: nodeId,
        activeAttemptId: null,
        status: "completed",
        requestedAt: at(-MINUTE_MS),
        startedAt: at(-MINUTE_MS),
        completedAt: at(),
        checkpointId: null,
        contextHandoffId: null,
      },
    ],
    messages: [
      {
        id: messageId,
        threadId,
        runId,
        nodeId,
        role: "user",
        text: "Explain this code",
        attachments: [],
        streaming: false,
        createdBy: "user",
        creationSource: "web",
        createdAt: at(-MINUTE_MS),
        updatedAt: at(-MINUTE_MS),
      },
    ],
    providerThreads: [
      {
        id: providerThreadId,
        driver: ProviderDriverKind.make("claudeAgent"),
        providerInstanceId: instanceId,
        providerSessionId: null,
        appThreadId: threadId,
        ownerNodeId: nodeId,
        nativeThreadRef: null,
        nativeConversationHeadRef: null,
        status: "idle",
        firstRunOrdinal: 1,
        lastRunOrdinal: 1,
        handoffIds: [],
        forkedFrom: null,
        pendingBackgroundTasks: [],
        createdAt: at(-MINUTE_MS),
        updatedAt: at(),
      },
    ],
    providerTurns: [
      {
        id: ProviderTurnId.make("provider-turn-1"),
        providerThreadId,
        nodeId,
        runAttemptId: null,
        nativeTurnRef: null,
        ordinal: 1,
        status: "completed",
        startedAt: at(-MINUTE_MS),
        completedAt: at(),
        tokenUsage: {
          usedTokens: usage.usedTokens ?? 250_000,
          ...(usage.cacheExpiresInMs === undefined
            ? {}
            : { promptCacheExpiresAt: DateTime.formatIso(at(usage.cacheExpiresInMs)) }),
          updatedAt: DateTime.formatIso(at()),
        },
      },
    ],
    runtimeRequests: [],
    turnItems: [],
    contextTransfers: [],
  };
}

describe("idleCompactionWindow", () => {
  it("skips small contexts, unknown expiry, other providers, switched threads, and compactions", () => {
    const cache = { cacheExpiresInMs: 60 * MINUTE_MS };
    expect(idleCompactionWindow(records({ ...cache, usedTokens: 199_999 }), NOW_MS)).toBeNull();
    expect(idleCompactionWindow(records(), NOW_MS)).toBeNull();
    const codex = records(cache);
    codex.providerThreads = [
      { ...codex.providerThreads[0]!, driver: ProviderDriverKind.make("codex") },
    ];
    expect(idleCompactionWindow(codex, NOW_MS)).toBeNull();
    const switched = records(cache);
    switched.thread = { ...switched.thread, providerInstanceId: ProviderInstanceId.make("codex") };
    expect(idleCompactionWindow(switched, NOW_MS)).toBeNull();
    const compacted = records(cache);
    compacted.messages = [{ ...compacted.messages[0]!, text: "/compact" }];
    expect(idleCompactionWindow(compacted, NOW_MS)).toBeNull();
    const archived = records(cache);
    archived.thread = { ...archived.thread, archivedAt: at() };
    expect(idleCompactionWindow(archived, NOW_MS)).toBeNull();
  });

  it("compacts a thread its own agent settled from 100K, and no other settled thread", () => {
    const cache = { cacheExpiresInMs: 60 * MINUTE_MS };
    const settled = (usedTokens: number, settledByOwnAgent?: boolean) => {
      const value = records({ ...cache, usedTokens });
      value.thread = {
        ...value.thread,
        settledOverride: "settled",
        settledAt: at(),
        ...(settledByOwnAgent === undefined ? {} : { settledByOwnAgent }),
      };
      return value;
    };
    expect(idleCompactionWindow(settled(100_000, true), NOW_MS)).toEqual({
      runId,
      startMs: NOW_MS + 58 * MINUTE_MS,
      endMs: NOW_MS + 60 * MINUTE_MS,
    });
    expect(idleCompactionWindow(settled(99_999, true), NOW_MS)).toBeNull();
    expect(idleCompactionWindow(settled(250_000, false), NOW_MS)).toBeNull();
    expect(idleCompactionWindow(settled(250_000), NOW_MS)).toBeNull();
    expect(idleCompactionWindow(records({ ...cache, usedTokens: 150_000 }), NOW_MS)).toBeNull();
  });

  it("waits for Claude's own background subagents but not for T3 delegates", () => {
    const withSubagent = (origin: "provider_native" | "app_owned") => {
      const value = records({ cacheExpiresInMs: 60 * MINUTE_MS });
      value.turnItems = [
        {
          id: TurnItemId.make("subagent-item"),
          threadId,
          runId,
          nodeId: NodeId.make("root-node"),
          providerThreadId,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 1,
          status: "running",
          title: "Fix review findings",
          startedAt: at(),
          completedAt: null,
          updatedAt: at(),
          type: "subagent",
          subagentId: NodeId.make("subagent-node"),
          origin,
          driver: ProviderDriverKind.make("claudeAgent"),
          providerInstanceId: instanceId,
          childThreadId: null,
          prompt: "Fix the findings",
          result: null,
        },
      ];
      return value;
    };
    expect(idleCompactionWindow(withSubagent("provider_native"), NOW_MS)).toBeNull();
    expect(idleCompactionWindow(withSubagent("app_owned"), NOW_MS)).toEqual({
      runId,
      startMs: NOW_MS + 58 * MINUTE_MS,
      endMs: NOW_MS + 60 * MINUTE_MS,
    });
  });
});
