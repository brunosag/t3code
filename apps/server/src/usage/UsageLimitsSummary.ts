import {
  EnvironmentId,
  PROVIDER_DISPLAY_NAMES,
  type ServerProvider,
  type UsageLimitSourceSnapshot,
} from "@t3tools/contracts";
import { limitRunway } from "@t3tools/shared/usageLimitRunway";
import {
  bankedResets,
  collectLimitAccounts,
  collectLimitPools,
  displayLimitWindows,
  type LimitPool,
  type LimitPoolWindow,
  type LimitPresentations,
  staleLimitAccounts,
  unshownFailedHubAccounts,
} from "@t3tools/shared/usageLimits";
import {
  collectLimitNotices,
  cursorUsageWindowDetails,
  limitsNotice,
} from "@t3tools/shared/usageLimitsCopy";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

const UsageLimitsAccount = Schema.Struct({
  name: Schema.String,
  plan: Schema.optional(Schema.String),
  capacity: Schema.optional(Schema.Number),
  checkedAt: Schema.String,
  off: Schema.optional(Schema.Literal(true)),
  stale: Schema.optional(Schema.Literal(true)),
  notice: Schema.optional(Schema.String),
});

const UsageLimitsLimit = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literals(["session", "weekly", "monthly", "other"]),
  label: Schema.String,
  models: Schema.optional(Schema.Array(Schema.String)),
  remainingPercent: Schema.Number,
  resets: Schema.Array(Schema.Struct({ at: Schema.String, restoresPercent: Schema.Number })),
  pace: Schema.optional(Schema.Literals(["ahead", "on", "under"])),
  burnPercentPerDay: Schema.optional(Schema.Number),
  safePercentPerDay: Schema.optional(Schema.Number),
  safeUntil: Schema.optional(Schema.String),
  runsOutAt: Schema.optional(Schema.String),
  outUntil: Schema.optional(Schema.String),
});

/** What `t3 thread usage --json` prints: the Limits view's pooled figures for this environment. */
export const UsageLimitsSummary = Schema.Struct({
  checkedAt: Schema.String,
  providers: Schema.Array(
    Schema.Struct({
      driver: Schema.String,
      name: Schema.String,
      accounts: Schema.Array(UsageLimitsAccount),
      limits: Schema.Array(UsageLimitsLimit),
      bankedResets: Schema.Array(
        Schema.Struct({
          label: Schema.String,
          count: Schema.Number,
          nextExpiresAt: Schema.optional(Schema.String),
          limitId: Schema.optional(Schema.String),
        }),
      ),
    }),
  ),
  notices: Schema.Array(Schema.String),
});
export type UsageLimitsSummary = typeof UsageLimitsSummary.Type;

const LOCAL = EnvironmentId.make("local");
const iso = (millis: number) => DateTime.formatIso(DateTime.makeUnsafe(millis));
const tenths = (value: number) => Math.round(value * 10) / 10;

function limitSummary(
  pool: LimitPool,
  window: LimitPoolWindow,
  now: number,
): (typeof UsageLimitsLimit)["Type"] {
  const runway = limitRunway(window, now);
  const models = [...new Set(window.members.flatMap((member) => member.window.modelIds ?? []))];
  const restored = new Map<number, number>();
  for (const reset of window.resets) {
    if (reset.at > now && reset.restoresPercent > 0) {
      restored.set(reset.at, (restored.get(reset.at) ?? 0) + reset.restoresPercent);
    }
  }
  const resets = [...restored].map(([at, restoresPercent]) => ({ at: iso(at), restoresPercent }));
  // As the view's cards: an empty limit says only when quota is back.
  const figures = () => {
    if (window.remainingPercent === 0) {
      const back = runway?.refills[0]?.at ?? [...restored.keys()][0];
      if (back !== undefined) return { outUntil: iso(back) };
      return runway?.pace ? { pace: runway.pace } : {};
    }
    if (runway === null) return {};
    const { burnPerDay, safe, out, pace } = runway;
    return {
      ...(pace === null ? {} : { pace }),
      ...(burnPerDay === null ? {} : { burnPercentPerDay: tenths(burnPerDay) }),
      ...(safe === null ? {} : { safePercentPerDay: tenths(safe.perDay) }),
      ...(safe !== null && Number.isFinite(safe.until) ? { safeUntil: iso(safe.until) } : {}),
      ...(out === null ? {} : { runsOutAt: iso(out.at) }),
      ...(out !== null && Number.isFinite(out.until) ? { outUntil: iso(out.until) } : {}),
    };
  };
  return {
    id: window.id,
    kind: window.kind,
    label:
      (pool.driver === "cursor" ? cursorUsageWindowDetails(window.id, pool)?.label : undefined) ??
      window.label,
    ...(models.length === 0 ? {} : { models }),
    remainingPercent: window.remainingPercent,
    resets,
    ...figures(),
  };
}

/** Each kind of banked reset, summed over the logins the pool counts. */
function bankedSummary(pool: LimitPool, windows: ReadonlyArray<LimitPoolWindow>) {
  const kinds = new Map<
    string,
    { label: string; count: number; expiries: Array<number>; limitId: string | undefined }
  >();
  for (const account of pool.accounts) {
    if (account.disabled) continue;
    for (const reset of bankedResets(account)) {
      const limitId = windows.find((window) =>
        window.members.some(
          (member) => member.account.key === account.key && member.window.id === reset.windowId,
        ),
      )?.id;
      const key = `${reset.label}\n${limitId ?? ""}`;
      const kind = kinds.get(key) ?? { label: reset.label, count: 0, expiries: [], limitId };
      kind.count += reset.availableCount;
      kind.expiries.push(...reset.expiries);
      kinds.set(key, kind);
    }
  }
  return [...kinds.values()].map(({ label, count, expiries, limitId }) => ({
    label,
    count,
    ...(expiries.length === 0 ? {} : { nextExpiresAt: iso(Math.min(...expiries)) }),
    ...(limitId === undefined ? {} : { limitId }),
  }));
}

/**
 * The Limits view's pooled figures for one environment, from what the server
 * already holds. A client's hidden providers and limits are its own choice,
 * so everything is here.
 */
export function summarizeUsageLimits(input: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly sources: ReadonlyArray<UsageLimitSourceSnapshot>;
  readonly now: number;
}): UsageLimitsSummary {
  const { now } = input;
  const presentations: LimitPresentations = new Map([
    [
      LOCAL,
      {
        entry: { target: { label: "" } },
        serverConfig: { providers: input.providers, usageLimitSources: input.sources },
      },
    ],
  ]);
  const pools = collectLimitPools(collectLimitAccounts(presentations), now);
  const providerName = (driver: ServerProvider["driver"]) =>
    PROVIDER_DISPLAY_NAMES[driver] ?? String(driver);

  // Hub logins without figures: a failed read no other report covers, and
  // every login of a provider that has no reading at all.
  const failed = unshownFailedHubAccounts(presentations);
  const unread = new Map<ServerProvider["driver"], Array<(typeof UsageLimitsAccount)["Type"]>>();
  for (const source of input.sources) {
    for (const account of source.accounts) {
      const notice = limitsNotice(account.usageLimits);
      if (notice === null) continue;
      if (!failed.has(account) && pools.some((pool) => pool.driver === account.driver)) continue;
      const listed = unread.get(account.driver) ?? [];
      listed.push({
        name: account.name ?? account.email ?? account.id.replace(/\.json$/i, ""),
        ...(account.plan === undefined ? {} : { plan: account.plan }),
        ...(account.capacity === undefined ? {} : { capacity: account.capacity }),
        checkedAt: account.usageLimits.checkedAt,
        ...(account.disabled === true ? { off: true as const } : {}),
        notice,
      });
      unread.set(account.driver, listed);
    }
  }

  const pooled = pools.map((pool) => {
    const name = providerName(pool.driver);
    const windows = displayLimitWindows(pool);
    const stale = new Set(staleLimitAccounts(pool.accounts, now).map((account) => account.key));
    return {
      driver: String(pool.driver),
      name,
      accounts: [
        ...pool.accounts.map((account) => ({
          name: account.displayName ?? account.email ?? name,
          ...(account.plan === undefined ? {} : { plan: account.plan }),
          ...(account.capacity === undefined ? {} : { capacity: account.capacity }),
          checkedAt: account.limits.checkedAt,
          ...(account.disabled ? { off: true as const } : {}),
          ...(stale.has(account.key) ? { stale: true as const } : {}),
        })),
        ...(unread.get(pool.driver) ?? []),
      ],
      limits: windows.map((window) => limitSummary(pool, window, now)),
      bankedResets: bankedSummary(pool, windows),
    };
  });
  const unpooled = [...unread]
    .filter(([driver]) => !pools.some((pool) => pool.driver === driver))
    .map(([driver, accounts]) => ({
      driver: String(driver),
      name: providerName(driver),
      accounts,
      limits: [],
      bankedResets: [],
    }));

  return {
    checkedAt: iso(now),
    providers: [...pooled, ...unpooled],
    notices: [...collectLimitNotices(presentations)],
  };
}
