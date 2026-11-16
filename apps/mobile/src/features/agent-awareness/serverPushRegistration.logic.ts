// fork: the Android app registers its FCM token with every server it connects to, and each
// server sends the agent activity pushes upstream's T3 Connect relay would have sent.
import type { EnvironmentId, MobilePushDeviceRegistration } from "@t3tools/contracts";

/** The account servers name in their pushes; the native handler drops any other. */
export const SERVER_PUSH_USER_ID = "t3-local";
/** A foreground re-registers a server at most this often, so it can replay the current card. */
export const SERVER_PUSH_REREGISTER_INTERVAL_MS = 60_000;

export interface ServerPushDeviceState {
  readonly deviceId: string;
  readonly token: string | null;
  readonly packageName: string | null;
  readonly label: string;
  readonly permissionGranted: boolean;
  /** Permission granted and the alert channel not silenced. */
  readonly alertsEnabled: boolean;
  readonly ongoingPreference: boolean | undefined;
}

export function makeServerPushRegistration(
  state: ServerPushDeviceState,
): MobilePushDeviceRegistration | null {
  if (!state.token || !state.packageName) return null;
  return {
    deviceId: state.deviceId,
    token: state.token,
    packageName: state.packageName,
    label: state.label,
    preferences: {
      notificationsEnabled: state.alertsEnabled,
      liveActivitiesEnabled: state.permissionGranted && state.ongoingPreference !== false,
      // Like the relay registration, the app has no per-kind switches.
      notifyOnApproval: true,
      notifyOnInput: true,
      notifyOnCompletion: true,
      notifyOnFailure: true,
    },
  };
}

export type ServerPushOutcome = "pending" | "delivering" | "no-delivery" | "unsupported" | "failed";

export interface ServerPushRecord {
  readonly signature: string;
  readonly at: number;
  readonly outcome: ServerPushOutcome;
}

/**
 * Which connected servers need this registration now. A server is sent it once per connection,
 * again when the registration changes, and again on a foreground after the re-register interval.
 * A server that doesn't know the method is left alone until it reconnects (an update restarts it).
 */
export function planServerPushRegistrations(input: {
  readonly connected: ReadonlyArray<EnvironmentId>;
  readonly records: ReadonlyMap<EnvironmentId, ServerPushRecord>;
  /** Null while the device has nothing to register, such as before it gets a push token. */
  readonly signature: string | null;
  readonly now: number;
  readonly foreground: boolean;
}): { readonly register: EnvironmentId[]; readonly forget: EnvironmentId[] } {
  const connected = new Set(input.connected);
  const forget = [...input.records.keys()].filter((environmentId) => !connected.has(environmentId));
  if (input.signature === null) return { register: [], forget };
  const register = input.connected.filter((environmentId) => {
    const record = input.records.get(environmentId);
    if (record === undefined) return true;
    if (record.outcome === "unsupported") return false;
    if (record.signature !== input.signature) return true;
    return (
      input.foreground &&
      record.outcome !== "pending" &&
      input.now - record.at >= SERVER_PUSH_REREGISTER_INTERVAL_MS
    );
  });
  return { register, forget };
}

/** An older server rejects the method it doesn't have with this RPC defect. */
export function isUnsupportedServerPushFailure(error: unknown): boolean {
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : undefined;
  return message?.includes("Unknown request tag") === true;
}

export type ServerPushStatus = "no-servers" | "no-token" | "pending" | "delivering" | "unavailable";

export function summarizeServerPush(input: {
  readonly connected: ReadonlyArray<EnvironmentId>;
  readonly records: ReadonlyMap<EnvironmentId, ServerPushRecord>;
  readonly hasRegistration: boolean;
}): ServerPushStatus {
  if (input.connected.length === 0) return "no-servers";
  if (!input.hasRegistration) return "no-token";
  const outcomes = input.connected.map(
    (environmentId) => input.records.get(environmentId)?.outcome ?? "pending",
  );
  if (outcomes.includes("delivering")) return "delivering";
  if (outcomes.includes("pending")) return "pending";
  return "unavailable";
}
