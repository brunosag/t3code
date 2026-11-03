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
  /** Up to two days back, or now when nothing is recorded. */
  readonly from: number;
  readonly to: number;
  /** Whether burn and safe pace apply: day-or-longer windows. Shorter ones fill in bursts. */
  readonly paced: boolean;
  /** Recorded pool balance in unbroken stretches, the last ending now; empty until the server has readings. */
  readonly past: ReadonlyArray<readonly RunwayPoint[]>;
  /** Balance ahead at the current burn; at the safe pace while the burn is unknown, or with no more use without a pace. */
  readonly projection: readonly RunwayPoint[];
  readonly refills: ReadonlyArray<{ readonly at: number; readonly percent: number }>;
  /** The first stretch the current burn leaves nothing; null while the burn is unknown. */
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

/** A session the pool blocks behind its spent weekly quota: no clock of its own, nothing usable. */
function blocked(window: ServerProviderUsageWindow) {
  return window.windowDurationMins === undefined && window.usedPercent >= 100;
}

function accountsOf(pool: Pool, now: number): Account[] | null {
  const cap = 100 / pool.members.length;
  const accounts: Account[] = [];
  for (const { window } of pool.members) {
    if (blocked(window)) {
      const reset = window.resetsAt ? Date.parse(window.resetsAt) : Infinity;
      accounts.push({ balance: 0, reset: reset > now ? reset : Infinity, period: Infinity, cap });
      continue;
    }
    const period = (window.windowDurationMins ?? 0) * MINUTE;
    let reset = window.resetsAt ? Date.parse(window.resetsAt) : Number.NaN;
    // An unused session has no clock yet; it starts full and starts counting on first use.
    if (!Number.isFinite(reset) && period > 0 && period < DAY && window.usedPercent === 0) {
      reset = Infinity;
    }
    if (period <= 0 || Number.isNaN(reset)) return null;
    // A reading taken before its own reset means the window has since refilled.
    const missed = reset > now ? 0 : Math.floor((now - reset) / period) + 1;
    accounts.push({
      balance: missed > 0 ? cap : ((100 - window.usedPercent) / 100) * cap,
      reset: reset + missed * period,
      period,
      cap,
    });
  }
  return accounts.some((account) => Number.isFinite(account.period)) ? accounts : null;
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
  const step = (history.stepMins ?? 60) * MINUTE;
  // Each bucket holds its step's last reading, so date it to the step's end.
  return [
    ...history.usedPercent.flatMap((used, index) =>
      used === null ? [] : [{ at: Math.min(start + (index + 1) * step, now), used }],
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

function pastBalance(pool: Pool, from: number, now: number): RunwayPoint[][] {
  // A blocked session's own readings show quota it cannot use, so it counts as empty.
  const byAccount = pool.members.map(({ window }) =>
    blocked(window)
      ? null
      : new Map(
          (readings(window, now) ?? []).slice(0, -1).map((sample) => [sample.at, sample.used]),
        ),
  );
  const [first, ...rest] = byAccount.filter((account) => account !== null);
  if (!first) return [];
  const shared = [...first.keys()].filter(
    (at) => at >= from && at < now && rest.every((account) => account.has(at)),
  );
  const points = [
    ...shared.map((at) => ({
      at,
      remaining:
        byAccount.reduce((sum, account) => sum + (account ? 100 - account.get(at)! : 0), 0) /
        byAccount.length,
    })),
    {
      at: now,
      remaining:
        pool.members.reduce((sum, { window }) => sum + (100 - window.usedPercent), 0) /
        pool.members.length,
    },
  ];
  // Readings stop while no client is open; joining across a gap would draw a reset as a slow climb.
  const step = Math.max(
    ...pool.members.map(({ window }) => (window.history?.stepMins ?? 60) * MINUTE),
  );
  const stretches: RunwayPoint[][] = [];
  for (const [index, point] of points.entries()) {
    const previous = points[index - 1];
    if (previous && point.at - previous.at <= step) stretches.at(-1)!.push(point);
    else stretches.push([point]);
  }
  return stretches.filter((stretch) => stretch.length > 1);
}

/** Spans one window ahead and up to two days back; windows shorter than a day get no burn or pace. */
export function limitRunway(pool: Pool, now: number): LimitRunway | null {
  const accounts = accountsOf(pool, now);
  if (!accounts) return null;
  const period = Math.max(
    ...accounts.flatMap((account) => (Number.isFinite(account.period) ? [account.period] : [])),
  );
  const paced = accounts.every((account) => account.period >= DAY);
  const from = now - Math.min(PAST, period);
  const burn = paced ? burnPerDay(pool, now) : null;
  const safe = paced ? safeBurn(accounts, now) : null;
  // Without a burn, assuming no more use stacks refills on an untouched balance and looks roomier than it is.
  const { points, refills, out } = simulate(accounts, burn ?? safe?.perDay ?? 0, now, now + period);
  const past = pastBalance(pool, from, now);
  const recorded = past.length > 0;
  return {
    from: recorded ? from : now,
    to: now + period,
    paced,
    past: recorded ? past : [],
    projection: points,
    refills,
    out: burn === null ? null : out,
    burnPerDay: burn,
    safe,
  };
}
