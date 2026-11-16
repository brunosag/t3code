import { describe, expect, it } from "vite-plus/test";
import type { EnvironmentId } from "@t3tools/contracts";

import {
  isUnsupportedServerPushFailure,
  makeServerPushRegistration,
  planServerPushRegistrations,
  SERVER_PUSH_REREGISTER_INTERVAL_MS,
  summarizeServerPush,
  type ServerPushOutcome,
  type ServerPushRecord,
} from "./serverPushRegistration.logic";

const a = "env-a" as EnvironmentId;
const b = "env-b" as EnvironmentId;

const record = (outcome: ServerPushOutcome, signature = "sig", at = 0): ServerPushRecord => ({
  signature,
  at,
  outcome,
});

const device = {
  deviceId: "device-1",
  token: "fcm-token",
  packageName: "com.bsag.t3code",
  label: "Pixel",
  permissionGranted: true,
  alertsEnabled: true,
  ongoingPreference: undefined,
};

describe("makeServerPushRegistration", () => {
  it("needs a push token and package name", () => {
    expect(makeServerPushRegistration({ ...device, token: null })).toBeNull();
    expect(makeServerPushRegistration({ ...device, packageName: null })).toBeNull();
  });

  it.each([
    [{}, { notificationsEnabled: true, liveActivitiesEnabled: true }],
    [{ ongoingPreference: false }, { notificationsEnabled: true, liveActivitiesEnabled: false }],
    [{ alertsEnabled: false }, { notificationsEnabled: false, liveActivitiesEnabled: true }],
    [
      { permissionGranted: false, alertsEnabled: false },
      { notificationsEnabled: false, liveActivitiesEnabled: false },
    ],
  ])("reports %o as %o", (overrides, preferences) => {
    expect(makeServerPushRegistration({ ...device, ...overrides })?.preferences).toMatchObject(
      preferences,
    );
  });
});

describe("planServerPushRegistrations", () => {
  const plan = (
    records: ReadonlyArray<readonly [EnvironmentId, ServerPushRecord]>,
    overrides: Partial<Parameters<typeof planServerPushRegistrations>[0]> = {},
  ) =>
    planServerPushRegistrations({
      connected: [a],
      records: new Map(records),
      signature: "sig",
      now: SERVER_PUSH_REREGISTER_INTERVAL_MS,
      foreground: false,
      ...overrides,
    });

  it.each<[string, ReadonlyArray<readonly [EnvironmentId, ServerPushRecord]>, object, boolean]>([
    ["a new connection", [], {}, true],
    ["an unchanged registration", [[a, record("delivering")]], {}, false],
    ["a changed registration", [[a, record("delivering", "old")]], {}, true],
    ["a foreground after the interval", [[a, record("delivering")]], { foreground: true }, true],
    [
      "a foreground within the interval",
      [[a, record("delivering", "sig", 1)]],
      { foreground: true },
      false,
    ],
    ["a foreground while one is in flight", [[a, record("pending")]], { foreground: true }, false],
    ["a foreground after a failure", [[a, record("failed")]], { foreground: true }, true],
    [
      "a server without the method",
      [[a, record("unsupported", "old")]],
      { foreground: true },
      false,
    ],
    ["no push token yet", [], { signature: null }, false],
  ])("decides for %s", (_name, records, overrides, registers) => {
    expect(plan(records, overrides).register).toEqual(registers ? [a] : []);
  });

  it("forgets disconnected servers, so a reconnect registers again", () => {
    const records = new Map([[b, record("unsupported")]]);
    expect(
      planServerPushRegistrations({
        connected: [a],
        records,
        signature: null,
        now: 0,
        foreground: false,
      }).forget,
    ).toEqual([b]);
    expect(
      planServerPushRegistrations({
        connected: [b],
        records: new Map(),
        signature: "sig",
        now: 0,
        foreground: false,
      }).register,
    ).toEqual([b]);
  });
});

describe("isUnsupportedServerPushFailure", () => {
  it.each([
    ["Unknown request tag: server.registerMobilePushDevice", true],
    [new Error("Unknown request tag: server.registerMobilePushDevice"), true],
    [new Error("socket closed"), false],
    [undefined, false],
  ])("classifies %o", (error, unsupported) => {
    expect(isUnsupportedServerPushFailure(error)).toBe(unsupported);
  });
});

describe("summarizeServerPush", () => {
  it.each<
    [
      ReadonlyArray<EnvironmentId>,
      ReadonlyArray<[EnvironmentId, ServerPushOutcome]>,
      boolean,
      string,
    ]
  >([
    [[], [], true, "no-servers"],
    [[a], [], false, "no-token"],
    [
      [a, b],
      [
        [a, "unsupported"],
        [b, "delivering"],
      ],
      true,
      "delivering",
    ],
    [[a, b], [[a, "no-delivery"]], true, "pending"],
    [
      [a, b],
      [
        [a, "no-delivery"],
        [b, "failed"],
      ],
      true,
      "unavailable",
    ],
  ])("%o with %o (registration %s) is %s", (connected, outcomes, hasRegistration, status) => {
    expect(
      summarizeServerPush({
        connected,
        records: new Map(outcomes.map(([id, outcome]) => [id, record(outcome)])),
        hasRegistration,
      }),
    ).toBe(status);
  });
});
