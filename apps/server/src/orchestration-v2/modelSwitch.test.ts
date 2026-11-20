import {
  ContextHandoffId,
  MessageId,
  ProviderInstanceId,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { modelChangeNote, modelSwitchSince } from "./modelSwitch.ts";

const instanceId = ProviderInstanceId.make("codex");
const selection = (model: string) => ({ instanceId, model });
const run = (
  message: string,
  ordinal: number,
  model: string,
  status: OrchestrationV2ThreadProjection["runs"][number]["status"] = "completed",
) =>
  ({
    ordinal,
    status,
    completedAt: null,
    contextHandoffId: null,
    userMessageId: MessageId.make(message),
    modelSelection: selection(model),
  }) as OrchestrationV2ThreadProjection["runs"][number];
const shown = (...messages: ReadonlyArray<string>) =>
  messages.map((message) => ({
    type: "user_message",
    messageId: MessageId.make(message),
    inputIntent: "turn_start",
    status: "completed",
    text: message,
    attachments: [],
  })) as unknown as OrchestrationV2ThreadProjection["turnItems"];

describe("modelSwitchSince", () => {
  it("measures from the latest run whose message is in the timeline", () => {
    // B failed before it started; its message shows "a -> b", so the next one must show "b -> a".
    expect(
      modelSwitchSince(
        {
          runs: [
            run("first", 1, "a"),
            run("failed", 2, "b", "failed"),
            run("queued", 3, "c", "queued"),
            run("undone", 4, "d", "rolled_back"),
          ],
          turnItems: shown("first", "failed", "queued", "undone"),
        },
        selection("a"),
      ),
    ).toEqual({ modelSwitch: { from: selection("b"), to: selection("a") } });
  });

  it("skips messages clients hide", () => {
    const [first, pending, compact, answer] = shown(
      "first",
      "pending",
      "/compact",
      "async-answer:question",
    );
    expect(
      modelSwitchSince(
        {
          runs: [
            run("first", 1, "a"),
            run("pending", 2, "b", "cancelled"),
            run("/compact", 3, "c"),
            run("async-answer:question", 4, "d"),
          ],
          turnItems: [
            first!,
            { ...pending!, inputIntent: "queued_turn", status: "pending" },
            compact!,
            answer!,
          ] as OrchestrationV2ThreadProjection["turnItems"],
        },
        selection("c"),
      ),
    ).toEqual({ modelSwitch: { from: selection("a"), to: selection("c") } });
  });

  it("counts a wake whose handoff row shows the swap", () => {
    const wake = {
      ...run("wake", 2, "other"),
      contextHandoffId: ContextHandoffId.make("handoff"),
    };
    expect(
      modelSwitchSince(
        { runs: [run("first", 1, "a"), wake], turnItems: shown("first") },
        selection("other"),
      ),
    ).toEqual({});
  });

  it("records nothing for a first run or an unchanged selection", () => {
    expect(modelSwitchSince({ runs: [], turnItems: [] }, selection("a"))).toEqual({});
    // A fork's first message compares with the run it forked from.
    expect(modelSwitchSince({ runs: [], turnItems: [] }, selection("a"), selection("b"))).toEqual({
      modelSwitch: { from: selection("b"), to: selection("a") },
    });
    expect(
      modelSwitchSince({ runs: [run("first", 1, "a")], turnItems: shown("first") }, selection("a")),
    ).toEqual({});
  });
});

describe("modelChangeNote", () => {
  const providerThreadId = ProviderThreadId.make("provider-thread:a");
  const written = (
    ordinal: number,
    model: string,
    status: OrchestrationV2ThreadProjection["runs"][number]["status"] = "completed",
    thread = providerThreadId,
  ) => ({
    run: { ...run(`m${ordinal}`, ordinal, model, status), id: RunId.make(`run:${ordinal}`) },
    attempt: {
      id: RunAttemptId.make(`attempt:${ordinal}`),
      runId: RunId.make(`run:${ordinal}`),
      providerThreadId: thread,
    },
    turn: { providerThreadId: thread, runAttemptId: RunAttemptId.make(`attempt:${ordinal}`) },
  });
  const note = (history: ReadonlyArray<ReturnType<typeof written>>, model: string) =>
    modelChangeNote({
      projection: {
        runs: history.map((entry) => entry.run),
        attempts: history.map((entry) => entry.attempt),
        providerTurns: history.map((entry) => entry.turn),
      } as unknown as Parameters<typeof modelChangeNote>[0]["projection"],
      run: { ordinal: 10, modelSelection: selection(model) },
    });

  it("names the model that wrote the thread's latest turn, on any provider", () => {
    expect(note([written(1, "a"), written(2, "b")], "c")).toBe(
      "Model change: earlier assistant turns in this conversation were written by b. You are c, continuing from here.",
    );
    expect(note([written(1, "a"), written(2, "b")], "b")).toBe("");
    expect(note([], "b")).toBe("");
    // Claude wrote the latest turn on its own provider thread; Codex takes over.
    const claude = written(2, "claude-opus-5-5", "completed", ProviderThreadId.make("pt:claude"));
    claude.run.modelSelection = {
      instanceId: ProviderInstanceId.make("claude"),
      model: "claude-opus-5-5",
    };
    expect(note([written(1, "gpt-5.6"), claude], "gpt-5.6")).toBe(
      "Model change: earlier assistant turns in this conversation were written by Claude Opus 5.5. You are GPT-5.6, continuing from here.",
    );
    expect(note([claude, written(3, "gpt-5.6")], "gpt-5.6")).toBe("");
  });

  it("ignores undone runs", () => {
    expect(note([written(1, "a"), written(2, "b", "rolled_back")], "a")).toBe("");
  });
});
