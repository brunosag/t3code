import type { ServerProviderUsageWindow } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { limitRunway } from "./usageLimitRunway.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const now = Date.parse("2026-11-02T14:00:00.000Z");
const iso = (at: number) => DateTime.formatIso(DateTime.makeUnsafe(at));

const weekly = (
  usedPercent: number,
  resetsIn: number,
  history?: ServerProviderUsageWindow["history"],
): { readonly window: ServerProviderUsageWindow } => ({
  window: {
    id: "seven_day",
    kind: "weekly",
    label: "Weekly",
    usedPercent,
    resetsAt: iso(now + resetsIn),
    windowDurationMins: 7 * 24 * 60,
    ...(history ? { history } : {}),
  },
});

/** Hourly buckets ending now, one value per hour. */
const hourly = (values: readonly number[]) => ({
  startsAt: iso(now - values.length * HOUR),
  usedPercent: values,
});

describe("limitRunway", () => {
  it("sets the safe burn by the refill that binds it, and projects it while the burn is unknown", () => {
    // 30% of the pool now and B's 50% back in a day must last until A resets.
    const runway = limitRunway(
      { members: [weekly(40, 5 * DAY + 3 * HOUR), weekly(100, DAY)] },
      now,
    );
    expect(runway?.safe?.perDay).toBeCloseTo(80 / (5 + 3 / 24), 3);
    expect(runway?.safe?.until).toBe(now + 5 * DAY + 3 * HOUR);
    expect(runway?.burnPerDay).toBeNull();
    // At the safe pace A is spent by its reset, so it refills its whole half.
    expect(runway?.refills.map(({ at, percent }) => [at, Math.round(percent)])).toEqual([
      [now + DAY, 50],
      [now + 5 * DAY + 3 * HOUR, 50],
    ]);
    const atReset = runway?.projection.find((point) => point.at === now + 5 * DAY + 3 * HOUR);
    expect(atReset?.remaining).toBeCloseTo(0, 3);
    expect(runway?.out).toBeNull();
  });

  it("reads the last day's burn across a reset", () => {
    // A reset 11.5 hours ago, between the readings for 13:00 and 14:00 hours back.
    const a = [...Array.from({ length: 36 }, () => 90), ...Array.from({ length: 12 }, () => 5)];
    const runway = limitRunway(
      {
        members: [
          weekly(20, 7 * DAY - 11.5 * HOUR, hourly(a)),
          weekly(100, 2 * DAY, hourly(Array.from({ length: 48 }, () => 100))),
        ],
      },
      now,
    );
    // A spent 5% after the reset and 15% since; B spent nothing.
    expect(runway?.burnPerDay).toBeCloseTo(10, 6);
    expect(runway?.past.at(-1)?.at(-1)).toEqual({ at: now, remaining: 40 });

    const young = limitRunway(
      { members: [weekly(20, 3 * DAY, hourly(Array.from({ length: 12 }, () => 10)))] },
      now,
    );
    expect(young?.burnPerDay).toBeNull();
  });

  it("keeps the pool's history and burn when a smaller account joins mid-day", () => {
    // Two Max 5x accounts and a Pro one at a fifth of their size, which joined 6 hours ago.
    const max = (values: readonly number[]) => ({
      ...weekly(values.at(-1)!, 3 * DAY, hourly(values)),
      share: 5 / 11,
    });
    const flat = Array.from({ length: 48 }, () => 50);
    const pro = {
      ...weekly(30, 5 * DAY, {
        startsAt: iso(now - 6 * HOUR),
        usedPercent: [10, 12, 15, 20, 25, 30],
      }),
      share: 1 / 11,
    };
    const runway = limitRunway(
      { members: [max(flat), max(Array.from({ length: 48 }, (_, i) => 26 + i / 2)), pro] },
      now,
    );
    // The second Max spent 12% of its quota over the day, the Pro 20% of its own since joining.
    expect(runway?.burnPerDay).toBeCloseTo((5 * 12 + 20) / 11, 6);
    const past = runway?.past.flat() ?? [];
    expect(past[0]?.at).toBe(now - 2 * DAY + HOUR);
    // The Pro account adds its quota from its first reading.
    const joined = past.findIndex((point) => point.at === now - 5 * HOUR);
    expect(past[joined]!.remaining - past[joined - 1]!.remaining).toBeCloseTo(
      90 / 11 - 5 / 11 / 2,
      6,
    );
    expect(past.at(-1)).toEqual({ at: now, remaining: (5 * 50 + 5 * 50.5 + 70) / 11 });
  });

  it("projects the stretch the current burn runs dry", () => {
    // 20% a day empties the 30% left in 1.5 days, a day before A resets.
    const values = Array.from({ length: 48 }, (_, index) => 70 - (47 - index) * (20 / 24));
    const runway = limitRunway({ members: [weekly(70, 2.5 * DAY, hourly(values))] }, now);
    expect(runway?.burnPerDay).toBeCloseTo(20, 6);
    expect(runway?.out).toEqual({ at: now + 1.5 * DAY, until: now + 2.5 * DAY });
    expect(runway?.safe?.perDay).toBeCloseTo(12, 3);
  });

  it("charts a session's refills without a pace", () => {
    const session = (
      window: Pick<ServerProviderUsageWindow, "usedPercent" | "resetsAt" | "history">,
    ) => ({
      window: {
        id: "five_hour",
        kind: "session" as const,
        label: "Session",
        windowDurationMins: 300,
        ...window,
      },
    });
    // A filled up over the last hour, with no readings for half of it; B is unused, so its window has not started; C is blocked
    // behind its spent weekly quota until Thursday.
    const runway = limitRunway(
      {
        members: [
          session({
            usedPercent: 60,
            resetsAt: iso(now + HOUR),
            history: {
              startsAt: iso(now - HOUR),
              stepMins: 10,
              usedPercent: [20, 30, null, null, 40, 60],
            },
          }),
          session({
            usedPercent: 0,
            history: {
              startsAt: iso(now - HOUR),
              stepMins: 10,
              usedPercent: [0, 0, null, null, 0, 0],
            },
          }),
          {
            window: {
              id: "five_hour",
              kind: "session",
              label: "Session",
              usedPercent: 100,
              resetsAt: iso(now + 3 * DAY),
              history: { startsAt: iso(now - 30 * 60_000), stepMins: 10, usedPercent: [0, 0, 0] },
            },
          },
        ],
      },
      now,
    );
    expect(runway).toMatchObject({
      from: now - 5 * HOUR,
      to: now + 5 * HOUR,
      paced: false,
      burnPerDay: null,
      safe: null,
      out: null,
      refills: [{ at: now + HOUR, percent: expect.closeTo(20, 6) }],
    });
    expect(
      runway?.past.map((stretch) =>
        stretch.map(({ at, remaining }) => [at, Math.round(remaining)]),
      ),
    ).toEqual([
      [
        [now - 50 * 60_000, 60],
        [now - 40 * 60_000, 57],
      ],
      [
        [now - 10 * 60_000, 53],
        [now, 47],
      ],
    ]);
  });
});
