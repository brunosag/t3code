import { assert, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUsageWindow,
  type UsageLimitSourceSnapshot,
  UsageLimitSourceId,
} from "@t3tools/contracts";

import * as DateTime from "effect/DateTime";

import { summarizeUsageLimits } from "./UsageLimitsSummary.ts";

const now = Date.parse("2026-03-10T12:00:00.000Z");
const HOUR = 3_600_000;
const claude = ProviderDriverKind.make("claudeAgent");
const antigravity = ProviderDriverKind.make("antigravity");

/** Hourly readings rising evenly to `used` over `hours`, the last one dated now. */
const history = (from: number, used: number, hours: number) => ({
  startsAt: DateTime.formatIso(DateTime.makeUnsafe(now - hours * HOUR)),
  stepMins: 60,
  usedPercent: Array.from({ length: hours }, (_, hour) => from + ((used - from) * hour) / hours),
});

const session = (
  usedPercent: number,
  resetsAt: string,
  from?: number,
): ServerProviderUsageWindow => ({
  id: "five_hour",
  kind: "session",
  label: "Session",
  usedPercent,
  resetsAt,
  windowDurationMins: 300,
  ...(from === undefined ? {} : { history: history(from, usedPercent, 3) }),
});
const weekly = (
  usedPercent: number,
  resetsAt: string,
  from?: number,
): ServerProviderUsageWindow => ({
  id: "seven_day",
  kind: "weekly",
  label: "Weekly",
  usedPercent,
  resetsAt,
  windowDurationMins: 10_080,
  ...(from === undefined ? {} : { history: history(from, usedPercent, 26) }),
});
const fable = (usedPercent: number, resetsAt: string): ServerProviderUsageWindow => ({
  ...weekly(usedPercent, resetsAt),
  id: "seven_day_fable",
  label: "Fable",
  modelIds: ["claude-fable-5-2"],
});
const weeklyReset = { creditId: "week", label: "Weekly reset", description: "Refills the week." };

const pool: UsageLimitSourceSnapshot = {
  id: UsageLimitSourceId.make("pool"),
  kind: "cliproxy",
  label: "Pool",
  checkedAt: "2026-03-10T11:58:00.000Z",
  accounts: [
    {
      id: "claude-ada@example.test.json",
      driver: claude,
      email: "ada@example.test",
      plan: "Max 20x",
      capacity: 20,
      priority: 2,
      usageLimits: {
        checkedAt: "2026-03-10T11:58:00.000Z",
        windows: [
          session(40, "2026-03-10T14:00:00.000Z", 10),
          weekly(30, "2026-03-13T12:00:00.000Z", 18),
          fable(50, "2026-03-13T12:00:00.000Z"),
        ],
        resetCredits: {
          availableCount: 3,
          nextCreditId: "week",
          options: [
            {
              ...weeklyReset,
              availableCount: 2,
              expiries: ["2026-03-27T00:00:00.000Z", "2026-03-20T00:00:00.000Z"],
              refills: ["seven_day"],
            },
            {
              creditId: "fable",
              label: "Fable reset",
              description: "Refills Fable's share of the week.",
              availableCount: 1,
              expiresAt: "2026-03-15T00:00:00.000Z",
              refills: ["seven_day_fable"],
            },
          ],
        },
      },
    },
    {
      id: "claude-bo@example.test.json",
      driver: claude,
      email: "bo@example.test",
      plan: "Max 5x",
      capacity: 5,
      priority: 1,
      usageLimits: {
        // The hub's last read of this login failed, so it carries an earlier reading.
        checkedAt: "2026-03-10T11:30:00.000Z",
        windows: [
          session(80, "2026-03-10T13:00:00.000Z", 50),
          weekly(90, "2026-03-11T12:00:00.000Z", 80),
          fable(100, "2026-03-11T12:00:00.000Z"),
        ],
        resetCredits: {
          availableCount: 1,
          nextCreditId: "week",
          options: [
            {
              ...weeklyReset,
              availableCount: 1,
              expiresAt: "2026-03-18T00:00:00.000Z",
              refills: ["seven_day"],
            },
          ],
        },
      },
    },
    {
      id: "claude-cy@example.test.json",
      driver: claude,
      email: "cy@example.test",
      plan: "Max 5x",
      capacity: 5,
      priority: 0,
      disabled: true,
      usageLimits: {
        checkedAt: "2026-03-10T11:58:00.000Z",
        windows: [
          session(0, "2026-03-10T15:00:00.000Z"),
          weekly(10, "2026-03-16T12:00:00.000Z"),
          fable(0, "2026-03-16T12:00:00.000Z"),
        ],
        resetCredits: {
          availableCount: 4,
          nextCreditId: "week",
          options: [{ ...weeklyReset, availableCount: 4, refills: ["seven_day"] }],
        },
      },
    },
    {
      id: "claude-dee@example.test.json",
      driver: claude,
      email: "dee@example.test",
      usageLimits: {
        checkedAt: "2026-03-10T11:58:00.000Z",
        windows: [],
        unavailable: { reason: "probeFailed", message: "The login has expired." },
      },
    },
    {
      id: "antigravity-work.json",
      driver: antigravity,
      name: "Work Google",
      plan: "Ultra",
      usageLimits: {
        checkedAt: "2026-03-10T11:58:00.000Z",
        windows: [
          {
            id: "gemini-4-neon-weekly",
            kind: "weekly",
            label: "Gemini 4 Neon weekly",
            modelIds: ["gemini-4-neon"],
            usedPercent: 60,
            resetsAt: "2026-03-12T00:00:00.000Z",
            windowDurationMins: 10_080,
          },
          {
            id: "gemini-4-neon-5h",
            kind: "session",
            label: "Gemini 4 Neon",
            modelIds: ["gemini-4-neon"],
            usedPercent: 100,
            resetsAt: "2026-03-10T15:00:00.000Z",
            windowDurationMins: 300,
          },
        ],
      },
    },
  ],
};

const failedSource: UsageLimitSourceSnapshot = {
  id: UsageLimitSourceId.make("spare"),
  kind: "cliproxy",
  label: "Spare pool",
  checkedAt: "2026-03-10T11:58:00.000Z",
  accounts: [],
  error: "The hub did not answer.",
};

const codex: ServerProvider = {
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: {
    status: "authenticated",
    email: "ada@example.test",
    label: "ChatGPT Pro 200 Subscription",
  },
  checkedAt: "2026-03-10T11:59:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
  usageLimits: {
    checkedAt: "2026-03-10T11:59:00.000Z",
    windows: [
      {
        id: "primary",
        kind: "session",
        label: "5h limit",
        usedPercent: 10,
        resetsAt: "2026-03-10T16:00:00.000Z",
        windowDurationMins: 300,
      },
      {
        id: "secondary",
        kind: "weekly",
        label: "Weekly limit",
        usedPercent: 45,
        resetsAt: "2026-03-14T12:00:00.000Z",
        windowDurationMins: 10_080,
      },
    ],
    resetCredits: { availableCount: 1, nextExpiresAt: "2026-03-30T00:00:00.000Z" },
  },
};

it("gives each provider's pooled limits as the Limits view shows them", () => {
  const summary = summarizeUsageLimits({
    providers: [codex],
    sources: [pool, failedSource],
    now,
  });
  assert.strictEqual(summary.checkedAt, "2026-03-10T12:00:00.000Z");
  assert.deepStrictEqual(
    summary.providers.map((provider) => provider.name),
    ["Codex", "Claude", "Antigravity"],
  );
  const claudeSummary = summary.providers[1]!;
  // A stale reading, a login switched off, and one with no figures say so.
  assert.deepStrictEqual(claudeSummary.accounts, [
    {
      name: "ada@example.test",
      plan: "Max 20x",
      capacity: 20,
      checkedAt: "2026-03-10T11:58:00.000Z",
    },
    {
      name: "bo@example.test",
      plan: "Max 5x",
      capacity: 5,
      checkedAt: "2026-03-10T11:30:00.000Z",
      stale: true,
    },
    {
      name: "cy@example.test",
      plan: "Max 5x",
      capacity: 5,
      checkedAt: "2026-03-10T11:58:00.000Z",
      off: true,
    },
    {
      name: "dee@example.test",
      checkedAt: "2026-03-10T11:58:00.000Z",
      notice: "The login has expired.",
    },
  ]);
  // Pooled by plan size, the switched-off login left out: (20 × 70 + 5 × 10) / 25 = 58.
  assert.deepStrictEqual(claudeSummary.limits[1], {
    id: "seven_day",
    kind: "weekly",
    label: "Weekly",
    remainingPercent: 58,
    resets: [
      { at: "2026-03-11T12:00:00.000Z", restoresPercent: 18 },
      { at: "2026-03-13T12:00:00.000Z", restoresPercent: 24 },
    ],
    pace: "under",
    burnPercentPerDay: 11.2,
    safePercentPerDay: 26,
    safeUntil: "2026-03-13T12:00:00.000Z",
  });
  assert.deepStrictEqual(claudeSummary.limits[2]!.models, ["claude-fable-5-2"]);
  // Banked resets by kind, the switched-off login's left out.
  assert.deepStrictEqual(claudeSummary.bankedResets, [
    {
      label: "Weekly reset",
      count: 3,
      nextExpiresAt: "2026-03-18T00:00:00.000Z",
      limitId: "seven_day",
    },
    {
      label: "Fable reset",
      count: 1,
      nextExpiresAt: "2026-03-15T00:00:00.000Z",
      limitId: "seven_day_fable",
    },
  ]);
  // An empty limit says only when it is back.
  assert.deepStrictEqual(summary.providers[2]!.limits[0], {
    id: "gemini-4-neon-5h",
    kind: "session",
    label: "Gemini 4 Neon",
    models: ["gemini-4-neon"],
    remainingPercent: 0,
    resets: [{ at: "2026-03-10T15:00:00.000Z", restoresPercent: 100 }],
    outUntil: "2026-03-10T15:00:00.000Z",
  });
  assert.deepStrictEqual(summary.notices, [
    "Pool · dee@example.test: The login has expired.",
    "Spare pool: The hub did not answer.",
  ]);
});
