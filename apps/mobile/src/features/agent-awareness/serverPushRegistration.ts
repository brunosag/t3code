// fork: the Android app registers its FCM token with every server it connects to, and each
// server sends the agent activity pushes upstream's T3 Connect relay would have sent.
import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import { AsyncResult } from "effect/reactivity";
import { Platform } from "react-native";
import {
  type EnvironmentId,
  type MobilePushDeviceRegistration,
  WS_METHODS,
} from "@t3tools/contracts";
import {
  createEnvironmentRpcCommand,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";

import { connectionAtomRuntime } from "../../connection/runtime";
import { subscribeAppActive } from "../../lib/appState";
import { loadOrCreateAgentAwarenessDeviceId } from "../../persistence/imperative";
import { appAtomRegistry } from "../../state/atom-registry";
import { mobilePreferencesAtom } from "../../state/preferences";
import { connectedEnvironmentIdsAtom } from "../../state/presentation";
import { configureAndroidAgentNotifications } from "./androidNotifications";
import { supportsAgentAwarenessPush } from "./capabilities";
import {
  isUnsupportedServerPushFailure,
  makeServerPushRegistration,
  planServerPushRegistrations,
  SERVER_PUSH_USER_ID,
  summarizeServerPush,
  type ServerPushRecord,
  type ServerPushStatus,
} from "./serverPushRegistration.logic";

const UNREGISTER_TIMEOUT_MS = 3_000;

const registerDevice = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "mobile-push:register-device",
  tag: WS_METHODS.serverRegisterMobilePushDevice,
});

const unregisterDevice = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "mobile-push:unregister-device",
  tag: WS_METHODS.serverUnregisterMobilePushDevice,
});

const records = new Map<EnvironmentId, ServerPushRecord>();
let pushToken: string | null = null;
let tokenRotations = 0;
let configuredHandler: string | null = null;
let status: ServerPushStatus = "no-servers";
const statusListeners = new Set<() => void>();
let syncing = false;
let queued: { foreground: boolean } | null = null;

function enabled(): boolean {
  return Platform.OS === "android" && supportsAgentAwarenessPush();
}

function setStatus(next: ServerPushStatus): void {
  if (next === status) return;
  status = next;
  for (const listener of statusListeners) listener();
}

export function getServerPushStatus(): ServerPushStatus {
  return status;
}

export function subscribeServerPushStatus(listener: () => void): () => void {
  statusListeners.add(listener);
  return () => {
    statusListeners.delete(listener);
  };
}

async function readPushToken(): Promise<string | null> {
  const rotationsBefore = tokenRotations;
  const token = await Notifications.getDevicePushTokenAsync().catch(() => null);
  const value =
    token?.type === "android" && typeof token.data === "string" ? token.data.trim() : "";
  // A rotation seen while this lookup ran is newer than what it returned.
  if (value && rotationsBefore === tokenRotations) pushToken = value;
  return pushToken;
}

async function alertChannelEnabled(): Promise<boolean> {
  if (Number(Platform.Version) < 26) return true;
  return Notifications.getNotificationChannelAsync("agent-alerts").then(
    (channel) => channel?.importance !== Notifications.AndroidImportance.NONE,
    () => false,
  );
}

async function syncOnce(foreground: boolean): Promise<void> {
  const preferences = appAtomRegistry.get(mobilePreferencesAtom);
  // The preferences subscription runs this again once they load.
  if (!AsyncResult.isSuccess(preferences)) return;
  const ongoingPreference = preferences.value.liveActivitiesEnabled;
  const [deviceId, permissions, token] = await Promise.all([
    loadOrCreateAgentAwarenessDeviceId(),
    Notifications.getPermissionsAsync(),
    pushToken === null || foreground ? readPushToken() : Promise.resolve(pushToken),
  ]);
  const alertsEnabled = permissions.granted && (await alertChannelEnabled());

  const handler = `${deviceId}|${ongoingPreference !== false}`;
  if (handler !== configuredHandler) {
    configureAndroidAgentNotifications(deviceId, SERVER_PUSH_USER_ID, ongoingPreference !== false);
    configuredHandler = handler;
  }

  const registration = makeServerPushRegistration({
    deviceId,
    token,
    packageName: Constants.expoConfig?.android?.package?.trim() || null,
    label: Constants.deviceName?.trim() || "Android device",
    permissionGranted: permissions.granted,
    alertsEnabled,
    ongoingPreference,
  });
  const summarize = () =>
    setStatus(
      summarizeServerPush({
        connected: appAtomRegistry.get(connectedEnvironmentIdsAtom),
        records,
        hasRegistration: registration !== null,
      }),
    );
  const signature = registration === null ? null : JSON.stringify(registration);
  const plan = planServerPushRegistrations({
    connected: appAtomRegistry.get(connectedEnvironmentIdsAtom),
    records,
    signature,
    now: Date.now(),
    foreground,
  });
  for (const environmentId of plan.forget) records.delete(environmentId);
  if (registration !== null && signature !== null) {
    for (const environmentId of plan.register) {
      records.set(environmentId, { signature, at: Date.now(), outcome: "pending" });
      void registerWith(environmentId, registration, signature).then(summarize);
    }
  }
  summarize();
}

async function registerWith(
  environmentId: EnvironmentId,
  registration: MobilePushDeviceRegistration,
  signature: string,
): Promise<void> {
  const result = await runAtomCommand(
    appAtomRegistry,
    registerDevice,
    { environmentId, input: registration },
    { reportFailure: false, reportDefect: false },
  );
  // A newer registration or a disconnect replaced this record meanwhile.
  if (records.get(environmentId)?.signature !== signature) return;
  const outcome =
    result._tag === "Success"
      ? result.value.deliveryAvailable
        ? "delivering"
        : "no-delivery"
      : isUnsupportedServerPushFailure(squashAtomCommandFailure(result))
        ? "unsupported"
        : "failed";
  records.set(environmentId, { signature, at: Date.now(), outcome });
}

function sync(foreground = false): void {
  if (syncing) {
    queued = { foreground: foreground || queued?.foreground === true };
    return;
  }
  syncing = true;
  void syncOnce(foreground)
    .catch((error: unknown) => {
      if (__DEV__) console.warn("[agent-awareness] server push registration failed", error);
    })
    .finally(() => {
      syncing = false;
      const next = queued;
      queued = null;
      if (next) sync(next.foreground);
    });
}

/** Registers again with every connected server after a permission or preference change. */
export function refreshServerPushRegistration(): void {
  if (enabled()) sync();
}

/** Stops a server's pushes before the app forgets it; best effort, since it may be offline. */
export async function unregisterServerPushDevice(environmentId: EnvironmentId): Promise<void> {
  if (!enabled() || !appAtomRegistry.get(connectedEnvironmentIdsAtom).includes(environmentId)) {
    return;
  }
  const deviceId = await loadOrCreateAgentAwarenessDeviceId().catch(() => null);
  if (deviceId === null) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    runAtomCommand(
      appAtomRegistry,
      unregisterDevice,
      { environmentId, input: { deviceId } },
      { reportFailure: false, reportDefect: false },
    ),
    new Promise((resolve) => {
      timer = setTimeout(resolve, UNREGISTER_TIMEOUT_MS);
    }),
  ]);
  clearTimeout(timer);
}

/** App-lifetime worker: on Android, keeps every connected server holding this device's push registration. */
export function installServerPushRegistration(): () => void {
  if (!enabled()) return () => {};
  const unsubscribeEnvironments = appAtomRegistry.subscribe(
    connectedEnvironmentIdsAtom,
    () => sync(),
    { immediate: true },
  );
  // Null until preferences load; only the ongoing-activity switch matters here.
  let ongoingPreference: boolean | undefined | null = null;
  const unsubscribePreferences = appAtomRegistry.subscribe(
    mobilePreferencesAtom,
    (result) => {
      if (!AsyncResult.isSuccess(result)) return;
      if (result.value.liveActivitiesEnabled === ongoingPreference) return;
      ongoingPreference = result.value.liveActivitiesEnabled;
      sync();
    },
    { immediate: true },
  );
  const unsubscribeAppActive = subscribeAppActive(() => sync(true));
  const tokenSubscription = Notifications.addPushTokenListener((token) => {
    if (token.type !== "android" || typeof token.data !== "string" || !token.data.trim()) return;
    pushToken = token.data.trim();
    tokenRotations++;
    sync();
  });
  return () => {
    unsubscribeEnvironments();
    unsubscribePreferences();
    unsubscribeAppActive();
    tokenSubscription.remove();
  };
}
