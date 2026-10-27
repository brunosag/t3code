import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import { isSameSchedule, nextScheduledRunAt } from "./Schedule.ts";

describe("scheduled task schedule calculation", () => {
  it("skips to the next matching fixed-time weekday", () => {
    const next = nextScheduledRunAt(
      { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 2, 3, 4, 5] },
      DateTime.makeZonedUnsafe(
        {
          year: 2026,
          month: 7,
          day: 3,
          hour: 10,
          minute: 0,
          second: 0,
          millisecond: 0,
        },
        { timeZone: "America/Los_Angeles", adjustForTimeZone: true },
      ),
    );
    const parts = next ? DateTime.toParts(next) : null;
    expect(parts?.weekDay).toBe(1);
    expect(parts?.hour).toBe(9);
    expect(parts?.minute).toBe(0);
  });

  it("keeps an interval on the grid its previous due time set", () => {
    const day = 24 * 60 * 60_000;
    const schedule = { type: "interval", everyMs: day } as const;
    const dueAt = DateTime.makeUnsafe("2026-10-20T07:00:00.000Z");
    const at = (iso: string, previous: DateTime.DateTime | null) => {
      const next = nextScheduledRunAt(schedule, DateTime.makeUnsafe(iso), previous);
      return next === null ? null : DateTime.formatIso(next);
    };

    expect(at("2026-10-20T09:34:40.797Z", null)).toBe("2026-10-21T09:34:40.797Z");
    // Late by hours, or by more than a whole interval: back on 07:00.
    expect(at("2026-10-20T09:34:40.797Z", dueAt)).toBe("2026-10-21T07:00:00.000Z");
    expect(at("2026-10-22T18:00:00.000Z", dueAt)).toBe("2026-10-23T07:00:00.000Z");
    // Exactly on a slot moves to the following one.
    expect(at("2026-10-21T07:00:00.000Z", dueAt)).toBe("2026-10-22T07:00:00.000Z");
    // A manual run before the due time leaves it in place.
    expect(at("2026-10-19T22:00:00.000Z", dueAt)).toBe("2026-10-20T07:00:00.000Z");
  });

  it("runs a one-time schedule only while its time is ahead", () => {
    const schedule = { type: "once", runAt: "2026-10-28T09:00:00-03:00" } as const;
    const next = (iso: string) => {
      const value = nextScheduledRunAt(schedule, DateTime.makeUnsafe(iso));
      return value === null ? null : DateTime.formatIso(value);
    };
    expect(next("2026-10-27T12:00:00.000Z")).toBe("2026-10-28T12:00:00.000Z");
    expect(next("2026-10-28T12:00:00.000Z")).toBeNull();
    expect(isSameSchedule(schedule, { type: "once", runAt: "2026-10-28T12:00:00.000Z" })).toBe(
      true,
    );
    expect(isSameSchedule(schedule, { type: "once", runAt: "2026-10-28T09:00:00.000Z" })).toBe(
      false,
    );
  });

  it("compares schedules structurally", () => {
    expect(
      isSameSchedule({ type: "interval", everyMs: 60_000 }, { type: "interval", everyMs: 60_000 }),
    ).toBe(true);
    expect(
      isSameSchedule({ type: "interval", everyMs: 60_000 }, { type: "interval", everyMs: 30_000 }),
    ).toBe(false);
    expect(
      isSameSchedule(
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 2] },
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 2] },
      ),
    ).toBe(true);
    expect(
      isSameSchedule(
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [5, 1] },
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 5, 5] },
      ),
    ).toBe(true);
    expect(
      isSameSchedule(
        { type: "fixed_time", timeOfDay: "09:00" },
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [0, 1, 2, 3, 4, 5, 6] },
      ),
    ).toBe(true);
    expect(
      isSameSchedule(
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [] },
        { type: "fixed_time", timeOfDay: "09:00" },
      ),
    ).toBe(true);
    expect(
      isSameSchedule(
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 2] },
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 3] },
      ),
    ).toBe(false);
    expect(
      isSameSchedule(
        { type: "fixed_time", timeOfDay: "09:00" },
        { type: "fixed_time", timeOfDay: "09:30" },
      ),
    ).toBe(false);
    expect(
      isSameSchedule(
        { type: "interval", everyMs: 60_000 },
        { type: "fixed_time", timeOfDay: "09:00" },
      ),
    ).toBe(false);
  });
});
