// Switches the service to a version installed with `t3 service install --defer-restart` once agent
// work is idle, so a deploy does not cut off running turns, subagents and their processes.
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";

import packageJson from "../../package.json" with { type: "json" };
import { BOOT_SERVICE_UNIT_FILE } from "../cloud/bootService.ts";
import { resolveServiceLauncherMode } from "../cloud/serviceLauncherClient.ts";
import {
  parseServiceState,
  SERVICE_RESTART_PENDING_FILE,
  SERVICE_STATE_FILE,
} from "../cloud/serviceProtocol.ts";
import * as ServerConfig from "../config.ts";
import { forkParked } from "../serverActivation.ts";
import * as ProcessRunner from "../processRunner.ts";
import { watchAgentWork } from "./SleepInhibitor.ts";

const CHECK_INTERVAL = Duration.minutes(1);
// Bridges the gap between a turn ending and its queued or follow-up turn starting.
const IDLE_GRACE = Duration.minutes(2);
// Agent work that never pauses still gets the new version eventually.
const MAX_DEFERRAL = Duration.hours(12);

/**
 * Runs `restart` once a pending version exists and agent work has been idle for
 * IDLE_GRACE, or MAX_DEFERRAL after the pending version was first seen.
 */
export const run = Effect.fn("IdleRestart.run")(function* (input: {
  readonly pendingVersion: Effect.Effect<string | undefined>;
  /** Undefined while agent work runs. */
  readonly idleSince: Effect.Effect<number | undefined>;
  /** Reports whether the restart was queued. */
  readonly restart: Effect.Effect<boolean>;
}) {
  let pendingSince: number | undefined;
  const check = Effect.gen(function* () {
    const version = yield* input.pendingVersion;
    const now = yield* Clock.currentTimeMillis;
    if (version === undefined) {
      pendingSince = undefined;
      return false;
    }
    pendingSince ??= now;
    const idleSince = yield* input.idleSince;
    const idle = idleSince !== undefined && now - idleSince >= Duration.toMillis(IDLE_GRACE);
    if (!idle && now - pendingSince < Duration.toMillis(MAX_DEFERRAL)) return false;
    yield* Effect.logInfo("restarting the service onto its installed version", { version, idle });
    return yield* input.restart;
  });
  yield* check.pipe(
    Effect.repeat({ schedule: Schedule.spaced(CHECK_INTERVAL), until: (restarted) => restarted }),
  );
});

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const { managed } = yield* resolveServiceLauncherMode().pipe(
      Effect.orElseSucceed(() => ({ managed: false })),
    );
    // On Linux the launcher always runs under the systemd unit this restarts.
    if ((yield* HostProcess.Platform) !== "linux" || !managed) {
      return;
    }
    const config = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const runner = yield* ProcessRunner.ProcessRunner;
    const runtimeDir = path.join(config.baseDir, "runtime");

    const idleSince = yield* Ref.make<number | undefined>(yield* Clock.currentTimeMillis);
    yield* watchAgentWork(
      "idle restart",
      Effect.acquireRelease(Ref.set(idleSince, undefined), () =>
        Clock.currentTimeMillis.pipe(Effect.flatMap((now) => Ref.set(idleSince, now))),
      ).pipe(Effect.andThen(Effect.never)),
    );

    // Only a version the launcher will start on restart counts as pending.
    const pendingVersion = Effect.gen(function* () {
      const marker = yield* fs
        .readFileString(path.join(runtimeDir, SERVICE_RESTART_PENDING_FILE))
        .pipe(Effect.option);
      const state = yield* fs
        .readFileString(path.join(runtimeDir, SERVICE_STATE_FILE))
        .pipe(Effect.option);
      if (Option.isNone(marker) || Option.isNone(state)) return undefined;
      const version = marker.value.trim();
      const selected = parseServiceState(state.value);
      return version !== packageJson.version &&
        selected?.activeVersion === version &&
        selected.update?.status !== "pending"
        ? version
        : undefined;
    });

    // The unit names the launcher of the version it starts, so reload before restarting.
    const restart = Effect.gen(function* () {
      for (const args of [
        ["--user", "daemon-reload"],
        ["--user", "restart", "--no-block", BOOT_SERVICE_UNIT_FILE],
      ]) {
        const result = yield* runner.run({ command: "systemctl", args, timeout: "30 seconds" });
        if (result.code !== 0) {
          yield* Effect.logWarning("could not restart the service", {
            args,
            code: result.code,
            stderr: result.stderr,
          });
          return false;
        }
      }
      return true;
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning("could not restart the service", { error }).pipe(Effect.as(false)),
      ),
    );

    yield* forkParked(run({ pendingVersion, idleSince: Ref.get(idleSince), restart }));
  }),
);
