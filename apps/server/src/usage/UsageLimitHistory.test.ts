import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  UsageLimitSourceId,
  type UsageLimitSourceSnapshot,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import * as UsageLimitHistory from "./UsageLimitHistory.ts";

const HOUR = 3_600_000;
const start = Date.parse("2026-11-02T10:00:00.000Z");

const snapshot = (weeklyUsed: number): UsageLimitSourceSnapshot[] => [
  {
    id: UsageLimitSourceId.make("hub"),
    kind: "cliproxy",
    label: "Hub",
    checkedAt: "2026-11-02T10:00:00.000Z",
    accounts: [
      {
        id: "a.json",
        driver: ProviderDriverKind.make("claudeAgent"),
        usageLimits: {
          checkedAt: "2026-11-02T10:00:00.000Z",
          windows: [
            {
              id: "five_hour",
              kind: "session",
              label: "Session",
              usedPercent: 50,
              windowDurationMins: 300,
            },
            {
              id: "seven_day",
              kind: "weekly",
              label: "Weekly",
              usedPercent: weeklyUsed,
              windowDurationMins: 10_080,
            },
          ],
        },
      },
    ],
  },
];

const windows = (snapshots: ReadonlyArray<UsageLimitSourceSnapshot>) =>
  snapshots[0]!.accounts[0]!.usageLimits.windows;

it("keeps each hour's last weekly reading for two days", () => {
  let readings = UsageLimitHistory.recordReadings({}, snapshot(10), start + 20 * 60_000);
  readings = UsageLimitHistory.recordReadings(readings, snapshot(12), start + 50 * 60_000);
  readings = UsageLimitHistory.recordReadings(
    readings,
    snapshot(15),
    start + 2 * HOUR + 5 * 60_000,
  );
  const [session, weekly] = windows(UsageLimitHistory.attachHistory(readings, snapshot(15)));
  expect(session?.history).toBeUndefined();
  expect(weekly?.history).toEqual({
    startsAt: "2026-11-02T10:00:00.000Z",
    usedPercent: [12, null, 15],
  });

  const later = UsageLimitHistory.recordReadings(readings, snapshot(30), start + 49 * HOUR);
  expect(windows(UsageLimitHistory.attachHistory(later, snapshot(30)))[1]?.history).toEqual({
    startsAt: "2026-11-02T12:00:00.000Z",
    usedPercent: [15, ...Array.from({ length: 46 }, () => null), 30],
  });
});

it.effect("keeps readings across a server restart", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(start);
    yield* (yield* UsageLimitHistory.make).annotate(snapshot(20));
    yield* TestClock.setTime(start + HOUR);
    const restarted = yield* UsageLimitHistory.make;
    const annotated = yield* restarted.annotate(snapshot(25));
    expect(windows(annotated)[1]?.history?.usedPercent).toEqual([20, 25]);
  }).pipe(
    Effect.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "usage-limit-history-" }).pipe(
        Layer.provideMerge(NodeServices.layer),
        Layer.provideMerge(Layer.succeed(HostProcess.Platform, "linux")),
      ),
    ),
  ),
);
