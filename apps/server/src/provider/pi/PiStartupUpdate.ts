import * as Effect from "effect/Effect";
import { ChildProcessSpawner } from "effect/unstable/process";

import {
  type ProviderMaintenanceCommandResult,
  runProviderMaintenanceCommandWithSpawner,
} from "../providerMaintenanceRunner.ts";

/**
 * T3 refreshes pi by invoking pi's own updater; it never edits pi's install or
 * runs a package manager against it. Pi owns its managed install, its lock, and
 * its package scope, which is why no ownership proof from the maintenance
 * resolver is involved here.
 *
 * `--all` (self plus floating packages such as pi-claude-bridge) and `--models`
 * (the pi.dev catalog overlays) are mutually exclusive in pi's parser, so the
 * refresh is two sequential steps. Each step stands alone: a self-update that
 * fails must not skip the catalog refresh, and vice versa. `--no-approve`
 * keeps both runs global — a pi spawned inside a project must not touch that
 * project's local files.
 */
export interface PiStartupUpdateStep {
  readonly name: string;
  readonly args: ReadonlyArray<string>;
}

export const PI_STARTUP_UPDATE_STEPS: ReadonlyArray<PiStartupUpdateStep> = [
  { name: "install update", args: ["update", "--all", "--no-approve"] },
  { name: "catalog refresh", args: ["update", "--models", "--no-approve"] },
];

const stepFailureDetail = (result: ProviderMaintenanceCommandResult): string => {
  if (result.timedOut) {
    return "timed out";
  }
  const stderr = result.stderr.trim().slice(-400);
  return `exit code ${result.exitCode}${stderr ? `: ${stderr}` : ""}`;
};

/**
 * Run every step in order, logging (never rethrowing) individual failures.
 * Returns whether at least one step succeeded: that is the signal a re-probe
 * can pick up new state, while an all-failure run (offline host, pi missing)
 * leaves the already-cached snapshot in place without a wasted respawn.
 */
export const runPiStartupUpdate = Effect.fn("PiStartupUpdate.run")(function* (input: {
  readonly binaryPath: string;
  readonly env: NodeJS.ProcessEnv;
}) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  let anySucceeded = false;
  for (const step of PI_STARTUP_UPDATE_STEPS) {
    const outcome = yield* runProviderMaintenanceCommandWithSpawner({
      spawner,
      command: input.binaryPath,
      args: step.args,
      env: input.env,
    }).pipe(
      Effect.map((result) =>
        result.timedOut || result.exitCode !== 0
          ? { ok: false as const, detail: stepFailureDetail(result) }
          : { ok: true as const, detail: "" },
      ),
      Effect.catch((error) => Effect.succeed({ ok: false as const, detail: error.message })),
    );
    if (outcome.ok) {
      anySucceeded = true;
    } else {
      yield* Effect.logWarning(`Pi startup ${step.name} failed`, {
        command: input.binaryPath,
        step: step.args.join(" "),
        detail: outcome.detail,
      });
    }
  }
  return anySucceeded;
});
