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
    // The reset draws as a jump at the first reading after it.
    const past = runway?.past.flat() ?? [];
    const jump = past.findIndex((point) => point.at === now - 11 * HOUR);
    expect(past.slice(jump - 1, jump + 2)).toEqual([
      { at: now - 12 * HOUR, remaining: 5 },
      { at: now - 11 * HOUR, remaining: 5 },
      { at: now - 11 * HOUR, remaining: 47.5 },
    ]);

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
    const joined = past.findLastIndex((point) => point.at === now - 5 * HOUR);
    expect(past[joined]!.remaining - past[joined - 1]!.remaining).toBeCloseTo(
      90 / 11 - 5 / 11 / 2,
      6,
    );
    expect(past.at(-1)).toEqual({ at: now, remaining: (5 * 50 + 5 * 50.5 + 70) / 11 });
  });

  it("projects the stretch the current burn runs dry, and weighs the burn against the safe pace", () => {
    const burning = (perDay: number) =>
      limitRunway(
        {
          members: [
            weekly(
              70,
              2.5 * DAY,
              hourly(Array.from({ length: 48 }, (_, index) => 70 - (47 - index) * (perDay / 24))),
            ),
          ],
        },
        now,
      );
    // 20% a day empties the 30% left in 1.5 days, a day before A resets.
    const runway = burning(20);
    expect(runway?.burnPerDay).toBeCloseTo(20, 6);
    expect(runway?.out).toEqual({ at: now + 1.5 * DAY, until: now + 2.5 * DAY });
    expect(runway?.safe?.perDay).toBeCloseTo(12, 3);
    expect(runway?.pace).toBe("ahead");
    // Just under the safe 12% a day is on pace; well under has room to spare.
    expect(burning(11.9)?.pace).toBe("on");
    expect(burning(9.5)?.pace).toBe("under");
  });

  it("charts a session's refills, with a burn only while it is in use", () => {
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
    // A filled up until half an hour ago, with no readings for part of it; B is unused, so its window has not started; C is
    // blocked behind its spent weekly quota until Thursday.
    const runway = limitRunway(
      {
        members: [
          session({
            usedPercent: 60,
            resetsAt: iso(now + HOUR),
            history: {
              startsAt: iso(now - HOUR),
              stepMins: 10,
              usedPercent: [20, 30, 60, null, 60, 60],
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
        [now - 30 * 60_000, 47],
      ],
      [
        [now - 10 * 60_000, 47],
        [now, 47],
      ],
    ]);

    // Spending 10% every ten minutes empties the 10% left in ten minutes, hours before the reset.
    const inUse = limitRunway(
      {
        members: [
          session({
            usedPercent: 90,
            resetsAt: iso(now + 3 * HOUR),
            history: {
              startsAt: iso(now - HOUR),
              stepMins: 10,
              usedPercent: [40, 50, 60, 70, 80, 90],
            },
          }),
        ],
      },
      now,
    );
    expect(inUse).toMatchObject({
      burnPerDay: expect.closeTo(1440, 6),
      out: { at: now + 10 * 60_000, until: now + 3 * HOUR },
      pace: null,
    });

    // The session restarted 30 minutes ago; the dips to 44 and 9.5 are the reading wavering, not resets.
    const wavering = limitRunway(
      {
        members: [
          session({
            usedPercent: 12,
            resetsAt: iso(now + 4.5 * HOUR),
            history: {
              startsAt: iso(now - HOUR),
              stepMins: 10,
              usedPercent: [null, 45, 44, 2, 10, 9.5],
            },
          }),
        ],
      },
      now,
    );
    // 2% at the reset, then 10% up to 12%, over 40 minutes.
    expect(wavering?.burnPerDay).toBeCloseTo((12 * 1440) / 40, 6);
    // Wavering readings smooth out instead of drawing false upward refill spikes, while the real reset still jumps.
    expect(
      wavering?.past.map((stretch) => stretch.map(({ at, remaining }) => [at, remaining])),
    ).toEqual([
      [
        [now - 40 * 60_000, 56],
        [now - 30 * 60_000, 56],
        [now - 20 * 60_000, 56],
        [now - 20 * 60_000, 98],
        [now - 10 * 60_000, 90],
        [now, 88],
      ],
    ]);
  });

  it("smooths noisy quota readings and settling holds without hiding real refills", () => {
    // Reproduces Antigravity's replica jitter and 1% holds settling back when going idle.
    const used = [
      2.3, 3.6, 5.8, 5.6, 8.4, 9.3, 7.7, 7.7, 7.7, 8.0, 9.2, 11.7, 10.9, 10.8, 13.0, 12.9, 16.0,
      14.9, 17.7, 19.4, 18.5, 20.8, 23.9, 23.5, 23.1, 23.1, 23.1, 23.2,
    ];
    const runway = limitRunway({ members: [weekly(22.5, 5 * DAY, hourly(used))] }, now);
    const past = runway?.past.flat() ?? [];
    // No upward steps anywhere in the smoothed curve, including into `now`.
    for (let index = 1; index < past.length; index++) {
      expect(past[index]!.remaining).toBeLessThanOrEqual(past[index - 1]!.remaining);
      expect(past[index]!.at).toBeGreaterThan(past[index - 1]!.at);
    }
    // Connects seamlessly to the live reading at `now` (`projection[0]`).
    expect(past.at(-1)).toEqual({ at: now, remaining: 77.5 });
    expect(runway?.projection[0]).toEqual({ at: now, remaining: 77.5 });

    // A small scheduled reset (3% -> 0% at the reset boundary) still draws as a refill jump.
    const smallReset = limitRunway(
      {
        members: [weekly(1, 7 * DAY - 2.5 * HOUR, hourly([2, 3, 3, 0, 0.5, 1]))],
      },
      now,
    );
    const resetPoints = smallReset?.past.flat() ?? [];
    const jump = resetPoints.findIndex((point) => point.at === now - 2 * HOUR);
    expect(resetPoints.slice(jump - 1, jump + 2)).toEqual([
      { at: now - 3 * HOUR, remaining: 97 },
      { at: now - 2 * HOUR, remaining: 97 },
      { at: now - 2 * HOUR, remaining: 100 },
    ]);

    // A small off-schedule hold settling (1.2% -> 0.2%) is not mistaken for a refill in burn or chart.
    const smallHold = limitRunway(
      {
        members: [
          {
            window: {
              id: "gemini-5h",
              kind: "session",
              label: "Gemini · 5-hour",
              usedPercent: 1.5,
              resetsAt: iso(now + 4 * HOUR),
              windowDurationMins: 300,
              history: {
                startsAt: iso(now - 50 * 60_000),
                stepMins: 10,
                usedPercent: [0.2, 1.2, 0.2, 0.5, 1.5],
              },
            },
          },
        ],
      },
      now,
    );
    expect(smallHold?.past.flat().map((point) => point.remaining)).toEqual([
      99.8, 99.8, 99.8, 99.5, 98.5,
    ]);
    // Spent 1.3% (0.2% -> 1.5%) over 40 minutes, without double-counting the 1% hold.
    expect(smallHold?.burnPerDay).toBeCloseTo((1.3 * 1440) / 40, 6);
  });
});
