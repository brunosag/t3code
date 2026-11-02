import type { ServerProviderUsageWindow } from "@t3tools/contracts";

/** The pool's accounts, each through its own reading of the window. */
interface Pool {
  readonly members: ReadonlyArray<{ readonly window: ServerProviderUsageWindow }>;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const PAST = 2 * DAY;
const EPSILON = 1e-9;

export interface RunwayPoint {
  readonly at: number;
  /** Pool percent left. */
  readonly remaining: number;
}

export interface LimitRunway {
  readonly from: number;
  readonly to: number;
  /** Recorded pool balance, ending now; empty until the server has readings. */
  readonly past: readonly RunwayPoint[];
  /** Balance ahead at the current burn, or with no more use when the burn is unknown. */
  readonly projection: readonly RunwayPoint[];
  readonly refills: ReadonlyArray<{ readonly at: number; readonly percent: number }>;
  /** The first stretch the projection has nothing left. */
  readonly out: { readonly at: number; readonly until: number } | null;
  /** Pool percent per day over the last day; null until every account has a day of readings. */
  readonly burnPerDay: number | null;
  /** The fastest steady burn that never runs out before quota comes back, and the refill that sets it. */
  readonly safe: { readonly perDay: number; readonly until: number } | null;
}

interface Account {
  balance: number;
  reset: number;
  readonly period: number;
  readonly cap: number;
}

function accountsOf(pool: Pool, now: number): Account[] | null {
  const cap = 100 / pool.members.length;
  const accounts: Account[] = [];
  for (const { window } of pool.members) {
    const period = (window.windowDurationMins ?? 0) * MINUTE;
    const reset = window.resetsAt ? Date.parse(window.resetsAt) : Number.NaN;
    if (period < DAY || !Number.isFinite(reset)) return null;
    // A reading taken before its own reset means the window has since refilled.
    const missed = reset > now ? 0 : Math.floor((now - reset) / period) + 1;
    accounts.push({
      balance: missed > 0 ? cap : ((100 - window.usedPercent) / 100) * cap,
      reset: reset + missed * period,
      period,
      cap,
    });
  }
  return accounts.length > 0 ? accounts : null;
}

/** Spends from the account that resets first, since its quota is lost at the reset. */
function simulate(start: readonly Account[], perDay: number, now: number, end: number) {
  const accounts = start.map((account) => ({ ...account }));
  const total = () => accounts.reduce((sum, account) => sum + account.balance, 0);
  const perMs = perDay / DAY;
  const points: RunwayPoint[] = [{ at: now, remaining: total() }];
  const refills: Array<{ at: number; percent: number }> = [];
  let out: { at: number; until: number } | null = null;
  let t = now;
  while (t < end) {
    const nextReset = Math.min(...accounts.map((account) => account.reset));
    const draining = accounts
      .filter((account) => account.balance > EPSILON)
      .sort((left, right) => left.reset - right.reset)[0];
    if (!draining && perMs > 0 && out === null) out = { at: t, until: nextReset };
    const emptiesAt = draining && perMs > 0 ? t + draining.balance / perMs : Infinity;
    const stop = Math.min(nextReset, emptiesAt, end);
    if (draining && perMs > 0) {
      draining.balance = stop === emptiesAt ? 0 : draining.balance - (stop - t) * perMs;
    }
    t = stop;
    points.push({ at: t, remaining: total() });
    if (t !== nextReset) continue;
    let restored = 0;
    for (const account of accounts) {
      if (account.reset !== t) continue;
      restored += account.cap - account.balance;
      account.balance = account.cap;
      account.reset += account.period;
    }
    if (restored > EPSILON) {
      refills.push({ at: t, percent: restored });
      points.push({ at: t, remaining: total() });
    }
  }
  return { points, refills, out };
}

function safeBurn(accounts: readonly Account[], now: number) {
  if (accounts.every((account) => account.balance <= EPSILON)) return null;
  // Every account has refilled once by the last first reset; past it the window repeats.
  const horizon = Math.max(...accounts.map((account) => account.reset));
  const runsOut = (perDay: number) => {
    const { out } = simulate(accounts, perDay, now, horizon);
    return out !== null && out.at < horizon ? out : null;
  };
  let low = 0;
  let high = 1;
  while (!runsOut(high) && high < 1e6) high *= 2;
  for (let step = 0; step < 40; step++) {
    const middle = (low + high) / 2;
    if (runsOut(middle)) high = middle;
    else low = middle;
  }
  const binding = runsOut(high);
  return binding ? { perDay: low, until: binding.until } : null;
}

function readings(window: ServerProviderUsageWindow, now: number) {
  const history = window.history;
  if (!history) return null;
  const start = Date.parse(history.startsAt);
  // Each bucket holds the hour's last reading, so date it to the hour's end.
  return [
    ...history.usedPercent.flatMap((used, index) =>
      used === null ? [] : [{ at: Math.min(start + (index + 1) * HOUR, now), used }],
    ),
    { at: now, used: window.usedPercent },
  ];
}

function burnPerDay(pool: Pool, now: number): number | null {
  let total = 0;
  for (const { window } of pool.members) {
    const samples = readings(window, now);
    const base = samples?.findLastIndex((sample) => sample.at <= now - DAY) ?? -1;
    if (!samples || base < 0) return null;
    const reset = window.resetsAt ? Date.parse(window.resetsAt) : Number.NaN;
    const period = (window.windowDurationMins ?? 0) * MINUTE;
    // A reading is dated to its hour's end, so a reset may fall up to an hour before it.
    const resetBetween = (from: number, to: number) =>
      [1, 2, 3].some((k) => from - HOUR < reset - k * period && reset - k * period <= to);
    let spent = 0;
    for (let index = base + 1; index < samples.length; index++) {
      const previous = samples[index - 1]!;
      const current = samples[index]!;
      spent +=
        current.used < previous.used
          ? resetBetween(previous.at, current.at)
            ? current.used
            : 0
          : current.used - previous.used;
    }
    total += spent / ((now - samples[base]!.at) / DAY);
  }
  return total / pool.members.length;
}

function pastBalance(pool: Pool, now: number): RunwayPoint[] {
  const byAccount = pool.members.map(
    ({ window }) =>
      new Map((readings(window, now) ?? []).slice(0, -1).map((sample) => [sample.at, sample.used])),
  );
  const [first, ...rest] = byAccount;
  if (!first) return [];
  const shared = [...first.keys()].filter(
    (at) => at >= now - PAST && at < now && rest.every((account) => account.has(at)),
  );
  return [
    ...shared.map((at) => ({
      at,
      remaining:
        byAccount.reduce((sum, account) => sum + (100 - account.get(at)!), 0) / byAccount.length,
    })),
    {
      at: now,
      remaining:
        pool.members.reduce((sum, { window }) => sum + (100 - window.usedPercent), 0) /
        pool.members.length,
    },
  ];
}

/** Pools of day-or-longer windows with reset clocks; shorter windows burn in bursts, so get none. */
export function limitRunway(pool: Pool, now: number): LimitRunway | null {
  const accounts = accountsOf(pool, now);
  if (!accounts) return null;
  const to = now + Math.max(...accounts.map((account) => account.period));
  const burn = burnPerDay(pool, now);
  const { points, refills, out } = simulate(accounts, burn ?? 0, now, to);
  const past = pastBalance(pool, now);
  return {
    from: now - PAST,
    to,
    past: past.length > 1 ? past : [],
    projection: points,
    refills,
    out,
    burnPerDay: burn,
    safe: safeBurn(accounts, now),
  };
}
