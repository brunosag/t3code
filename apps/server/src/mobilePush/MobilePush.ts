// fork: the fork's Android app can't use T3 Connect, so this server pushes agent activity to the
// devices that register with it, with the data upstream's relay sends (FcmDeliveries.process).
import {
  MobilePushError,
  type MobilePushDeviceRegistration,
  type MobilePushRegistrationResult,
  type ThreadId,
} from "@t3tools/contracts";
import {
  RelayAgentAwarenessPreferences,
  type RelayAgentActivityAggregateState,
  type RelayAgentActivityState,
} from "@t3tools/contracts/relay";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import {
  makeAggregateState,
  statusForPhase,
} from "../../../../infra/relay/src/agentActivity/agentActivityAggregate.ts";
import {
  alertForActivityRows,
  attentionTransitionRows,
  shouldAlertForActivity,
  terminalTransitionRows,
} from "../../../../infra/relay/src/agentActivity/agentActivityAlerts.ts";
import {
  isExpiredAgentActivityState,
  notificationForActivity,
} from "../../../../infra/relay/src/agentActivity/agentActivityPayloads.ts";
import {
  androidActivityData,
  fitFcmData,
} from "../../../../infra/relay/src/agentActivity/fcmPayloads.ts";
import * as ServerConfig from "../config.ts";
import * as FcmSender from "./FcmSender.ts";

/** The app configures its native receiver with this user id for server-sent pushes. */
const LOCAL_PUSH_USER_ID = "t3-local";
const DEVICES_FILE = "mobile-push-devices.json";
const CREDENTIALS_FILE = "fcm-service-account.json";

const StoredDevice = Schema.Struct({
  deviceId: Schema.String,
  token: Schema.String,
  packageName: Schema.String,
  label: Schema.String,
  preferences: RelayAgentAwarenessPreferences,
  updatedAt: Schema.String,
});
type StoredDevice = typeof StoredDevice.Type;
const DevicesJson = Schema.fromJsonString(Schema.Array(StoredDevice));
const decodeDevices = Schema.decodeUnknownOption(DevicesJson);
const encodeDevices = Schema.encodeSync(DevicesJson);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

// Copied from infra/relay's FcmDeliveries.ts, which can't be imported: it pulls in the relay's
// database. Keep these two in step with it.
function androidAlertForState(
  state: RelayAgentActivityState,
  preferences: RelayAgentAwarenessPreferences,
  nowMs: number,
) {
  if (!shouldAlertForActivity({ ...state, preferences, nowMs })) return null;
  const notification = notificationForActivity({ ...state, status: statusForPhase(state.phase) });
  return {
    alert_id: JSON.stringify([state.environmentId, state.threadId, state.phase, state.updatedAt]),
    alert_group: JSON.stringify([state.environmentId, state.threadId]),
    alert_title: notification.title,
    alert_body: notification.body,
    alert_path: notification.deepLink,
  };
}

function androidAlertForAggregate(input: {
  readonly previousAggregate: RelayAgentActivityAggregateState;
  readonly nextAggregate: RelayAgentActivityAggregateState;
  readonly preferences: RelayAgentAwarenessPreferences;
  readonly nowMs: number;
}) {
  if (!input.preferences.notificationsEnabled) return null;
  const attention = attentionTransitionRows(input);
  const activities =
    attention.length > 0
      ? attention
      : terminalTransitionRows({ ...input, includeUnobserved: true });
  const first = activities[0];
  const alert = alertForActivityRows(activities);
  if (!first || !alert) return null;
  if (activities.length === 1) {
    const notification = notificationForActivity(first);
    return {
      alert_id: JSON.stringify([first.environmentId, first.threadId, first.phase, first.updatedAt]),
      alert_group: JSON.stringify([first.environmentId, first.threadId]),
      alert_title: notification.title,
      alert_body: notification.body,
      alert_path: notification.deepLink,
    };
  }
  return {
    alert_id: JSON.stringify(
      activities
        .map((row) => [row.environmentId, row.threadId, row.phase, row.updatedAt])
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    ),
    alert_title: alert.title,
    alert_body: alert.body,
    alert_path: "/",
  };
}

type Job =
  | {
      readonly _tag: "state";
      readonly threadId: ThreadId;
      readonly state: RelayAgentActivityState | null;
    }
  | { readonly _tag: "replay"; readonly deviceId: string };

export class MobilePush extends Context.Service<
  MobilePush,
  {
    readonly register: (
      registration: MobilePushDeviceRegistration,
    ) => Effect.Effect<MobilePushRegistrationResult, MobilePushError>;
    readonly unregister: (input: {
      readonly deviceId: string;
    }) => Effect.Effect<void, MobilePushError>;
    /** Takes each top-level thread's published activity state; `null` clears the thread. */
    readonly publish: (input: {
      readonly threadId: ThreadId;
      readonly state: RelayAgentActivityState | null;
    }) => Effect.Effect<void>;
    readonly drain: Effect.Effect<void>;
  }
>()("t3/mobilePush/MobilePush") {}

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const config = yield* ServerConfig.ServerConfig;
  const digest = yield* Digest.Digest;
  const sender = yield* FcmSender.FcmSender;
  const devicesPath = path.join(config.stateDir, DEVICES_FILE);
  const credentialsPath = path.join(config.stateDir, CREDENTIALS_FILE);

  const stored = yield* fileSystem.readFileString(devicesPath).pipe(Effect.option);
  const devices = new Map(
    Option.getOrElse(Option.flatMap(stored, decodeDevices), () => []).map(
      (device) => [device.deviceId, device] as const,
    ),
  );
  const states = new Map<ThreadId, RelayAgentActivityState>();
  // The relay keeps each device's last delivered card as its alert baseline; a restart loses it,
  // and the receiver's seen-alert ids keep the first alerts after one from repeating.
  const deliveredAggregates = new Map<string, RelayAgentActivityAggregateState | null>();
  const devicesLock = yield* Semaphore.make(1);

  const saveDevices = Effect.fnUntraced(function* () {
    yield* writeFileStringAtomically({
      filePath: devicesPath,
      contents: encodeDevices([...devices.values()]),
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.provideService(HostProcess.Platform, platform),
      Effect.tapError((cause) =>
        Effect.logWarning("could not save mobile push devices", { cause }),
      ),
      Effect.mapError(
        () => new MobilePushError({ message: "Could not save the device registration." }),
      ),
    );
  });

  // Read per delivery so credentials dropped into the state directory apply without a restart.
  const readServiceAccount = fileSystem.readFileString(credentialsPath).pipe(
    Effect.map((contents) => (FcmSender.isServiceAccount(contents) ? contents : null)),
    Effect.orElseSucceed(() => null),
  );

  const removeUnregistered = (device: StoredDevice) =>
    devicesLock.withPermits(1)(
      Effect.gen(function* () {
        if (devices.get(device.deviceId)?.token !== device.token) return;
        devices.delete(device.deviceId);
        deliveredAggregates.delete(device.deviceId);
        yield* Effect.logInfo("removed mobile push device with an unregistered token", {
          deviceId: device.deviceId,
        });
        yield* saveDevices().pipe(Effect.ignore);
      }),
    );

  // Untraced: runs per device for each published state, under deliver's span.
  const deliverTo = Effect.fnUntraced(function* (
    device: StoredDevice,
    job: { readonly state: RelayAgentActivityState | null; readonly replay: boolean },
    serviceAccount: string,
    nowMs: number,
  ) {
    const preferences = device.preferences;
    const aggregate = makeAggregateState({
      activeStates: preferences.liveActivitiesEnabled ? [...states.values()] : [],
      terminalState: null,
      nowMs,
    });
    const previousAggregate = deliveredAggregates.get(device.deviceId) ?? null;
    let alert: ReturnType<typeof androidAlertForState | typeof androidAlertForAggregate> = null;
    // Deletions update the card but must not consume another thread's pending completion alert.
    const acknowledgeAggregate = job.state !== null || job.replay || aggregate === null;
    if (job.state && preferences.notificationsEnabled) {
      if (preferences.liveActivitiesEnabled && previousAggregate && aggregate) {
        alert = androidAlertForAggregate({
          previousAggregate,
          nextAggregate: aggregate,
          preferences,
          nowMs,
        });
      } else if (!isExpiredAgentActivityState(job.state, nowMs)) {
        alert = androidAlertForState(job.state, preferences, nowMs);
      }
    }
    const displayedAggregate = preferences.liveActivitiesEnabled ? aggregate : null;
    if (!displayedAggregate && !alert && !previousAggregate && job.state !== null) return;
    const data: Record<string, string> = {
      t3_kind: "agent_activity",
      device_id: device.deviceId,
      user_id: LOCAL_PUSH_USER_ID,
      updated_at: String(nowMs),
      ...androidActivityData(displayedAggregate),
      ...alert,
    };
    if (alert) {
      const hash = yield* digest
        .digest(Digest.sha256, new TextEncoder().encode(alert.alert_id))
        .pipe(Effect.orDie);
      data.alert_id = Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join("");
    }
    const result = yield* sender.send({
      serviceAccount,
      token: device.token,
      packageName: device.packageName,
      alert: alert !== null,
      data: fitFcmData(data),
    });
    if (result.unregistered) {
      yield* removeUnregistered(device);
    } else if (acknowledgeAggregate) {
      deliveredAggregates.set(
        device.deviceId,
        preferences.liveActivitiesEnabled ? aggregate : null,
      );
    }
  });

  const deliver = Effect.fn("MobilePush.deliver")(function* (job: Job) {
    if (job._tag === "state") {
      const previous = states.get(job.threadId);
      // Relay retries can hand over a state already taken.
      if (
        job.state === null
          ? previous === undefined
          : previous !== undefined && encodeJson(previous) === encodeJson(job.state)
      ) {
        return;
      }
      if (job.state === null) states.delete(job.threadId);
      else states.set(job.threadId, job.state);
    }
    const targets =
      job._tag === "replay"
        ? [devices.get(job.deviceId)].filter((device) => device !== undefined)
        : [...devices.values()];
    if (targets.length === 0) return;
    const serviceAccount = yield* readServiceAccount;
    if (serviceAccount === null) return;
    const nowMs = yield* Clock.currentTimeMillis;
    yield* Effect.forEach(
      targets,
      (device) =>
        deliverTo(
          device,
          job._tag === "state"
            ? { state: job.state, replay: false }
            : { state: null, replay: true },
          serviceAccount,
          nowMs,
        ).pipe(
          Effect.catch((error) =>
            Effect.logWarning("mobile push delivery failed", {
              deviceId: device.deviceId,
              error: error.message,
            }),
          ),
        ),
      { concurrency: 4, discard: true },
    );
  });

  const worker = yield* makeDrainableWorker(deliver);

  return MobilePush.of({
    register: Effect.fn("MobilePush.register")(function* (registration) {
      const updatedAt = DateTime.formatIso(yield* DateTime.now);
      yield* devicesLock.withPermits(1)(
        Effect.gen(function* () {
          const previous = devices.get(registration.deviceId);
          if (previous !== undefined && previous.token !== registration.token) {
            deliveredAggregates.delete(registration.deviceId);
          }
          devices.set(registration.deviceId, {
            deviceId: registration.deviceId,
            token: registration.token,
            packageName: registration.packageName,
            label: registration.label,
            preferences: registration.preferences,
            updatedAt,
          });
          yield* saveDevices();
        }),
      );
      yield* worker.enqueue({ _tag: "replay", deviceId: registration.deviceId });
      return { deliveryAvailable: (yield* readServiceAccount) !== null };
    }),
    unregister: Effect.fn("MobilePush.unregister")(function* ({ deviceId }) {
      yield* devicesLock.withPermits(1)(
        Effect.gen(function* () {
          if (!devices.delete(deviceId)) return;
          deliveredAggregates.delete(deviceId);
          yield* saveDevices();
        }),
      );
    }),
    publish: Effect.fn("MobilePush.publish")(function* (input) {
      yield* worker.enqueue({ _tag: "state", ...input });
    }),
    drain: worker.drain,
  });
});

export const layer = Layer.effect(MobilePush, make);
