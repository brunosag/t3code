// fork: the Android app registers with each server it connects to, and the server sends its
// agent activity pushes through Firebase itself instead of upstream's T3 Connect relay.
import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { RelayAgentAwarenessPreferences } from "./relay.ts";

export const MobilePushDeviceRegistration = Schema.Struct({
  deviceId: TrimmedNonEmptyString,
  /** The device's native FCM registration token. */
  token: TrimmedNonEmptyString,
  packageName: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  preferences: RelayAgentAwarenessPreferences,
});
export type MobilePushDeviceRegistration = typeof MobilePushDeviceRegistration.Type;

export const MobilePushRegistrationResult = Schema.Struct({
  /** False when the server has no Firebase credentials, so it cannot send pushes. */
  deliveryAvailable: Schema.Boolean,
});
export type MobilePushRegistrationResult = typeof MobilePushRegistrationResult.Type;

export class MobilePushError extends Schema.TaggedError<MobilePushError>()("MobilePushError", {
  message: Schema.String,
}) {}
