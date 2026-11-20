import {
  isCompactionCommandMessage,
  type ModelSelection,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { modelLabel } from "@t3tools/provider-core/server/handoffBudget";
import { modelSelectionsEqual } from "@t3tools/shared/model";
import { runRanAfter } from "@t3tools/shared/orchestrationV2ThreadError";

/**
 * Clients hide pending queued messages, fold async answers into their question, and replace
 * `/compact` with a compaction row.
 */
export const isShownUserMessageItem = (item: OrchestrationV2TurnItem): boolean =>
  item.type === "user_message" &&
  !(item.inputIntent === "queued_turn" && item.status === "pending") &&
  !item.messageId.startsWith("async-answer:") &&
  !isCompactionCommandMessage({ role: "user", ...item });

type ModelSwitchRun = OrchestrationV2ThreadProjection["runs"][number];

/** A run that has not been undone and has started or can start. */
export const isModelSwitchCandidate = (run: ModelSwitchRun): boolean =>
  run.status !== "rolled_back" && run.status !== "queued";

/** A run `modelSwitchSince` can measure from: its prompt is shown, or its handoff row shows it. */
export const anchorsModelSwitch = (run: ModelSwitchRun, shownMessageIds: ReadonlySet<string>) =>
  isModelSwitchCandidate(run) &&
  (shownMessageIds.has(run.userMessageId) || run.contextHandoffId !== null);

/**
 * The model or effort change a new run brings, measured from the latest run the timeline shows
 * through its message or its handoff row, so consecutive dividers always chain. `baseline` stands
 * in when there is none, such as a fork's source run. Callers skip starts with a context handoff;
 * the handoff item already shows those.
 */
export function modelSwitchSince(
  projection: Pick<OrchestrationV2ThreadProjection, "runs" | "turnItems">,
  to: ModelSelection,
  baseline?: ModelSelection,
): Pick<Extract<OrchestrationV2TurnItem, { type: "user_message" }>, "modelSwitch"> {
  const shown = new Set(
    projection.turnItems.flatMap((item) =>
      item.type === "user_message" && isShownUserMessageItem(item) ? [item.messageId] : [],
    ),
  );
  let previous: ModelSwitchRun | undefined;
  for (const run of projection.runs) {
    // A wake shows as a notification, but its context handoff row still shows the swap.
    if (!anchorsModelSwitch(run, shown)) continue;
    if (previous === undefined || runRanAfter(run, previous)) previous = run;
  }
  const from = previous?.modelSelection ?? baseline;
  return from === undefined || modelSelectionsEqual(from, to) ? {} : { modelSwitch: { from, to } };
}

/**
 * Tells the model taking over a thread which model wrote its latest accepted turn, on any
 * provider. Effort changes keep the model, so they need no note.
 */
export function modelChangeNote(input: {
  readonly projection: Pick<OrchestrationV2ThreadProjection, "runs" | "attempts" | "providerTurns">;
  readonly run: Pick<ModelSwitchRun, "ordinal" | "modelSelection">;
}): string {
  const acceptedAttemptIds = new Set(
    input.projection.providerTurns.flatMap((turn) =>
      turn.runAttemptId === null ? [] : [turn.runAttemptId],
    ),
  );
  const writtenRunIds = new Set(
    input.projection.attempts.flatMap((attempt) =>
      acceptedAttemptIds.has(attempt.id) ? [attempt.runId] : [],
    ),
  );
  let previous: ModelSwitchRun | undefined;
  for (const run of input.projection.runs) {
    if (
      writtenRunIds.has(run.id) &&
      run.status !== "rolled_back" &&
      run.ordinal < input.run.ordinal &&
      (previous === undefined || run.ordinal > previous.ordinal)
    )
      previous = run;
  }
  if (previous === undefined) return "";
  const from = modelLabel(previous.modelSelection);
  const to = modelLabel(input.run.modelSelection);
  return from === to
    ? ""
    : `Model change: earlier assistant turns in this conversation were written by ${from}. You are ${to}, continuing from here.`;
}
