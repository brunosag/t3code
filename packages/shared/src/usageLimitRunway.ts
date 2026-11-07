import type { ServerProviderUsageWindow } from "@t3tools/contracts";

import type { LimitPace } from "./usageLimits.ts";

/** The pool's accounts, each through its own reading of the window. */
interface Pool {
  readonly members: ReadonlyArray<{
    readonly window: ServerProviderUsageWindow;
    /** Part of the pool's quota; equal parts when omitted. */
    readonly share?: number;
  }>;
}

const shareOf = (pool: Pool, member: Pool["members"][number]) =>
  member.share ?? 1 / pool.members.length;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const PAST = 2 * DAY;
/** How far back a session's burn reads, and how recent its last spend must be to count as in use. */
const RECENT = HOUR;
const IN_USE = 20 * MINUTE;
/** Burn under this part of the safe pace has room for a heavier day; up to the safe pace it is on pace. */
const ROOM = 0.8;
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
  /** Whether the safe pace applies: day-or-longer windows. Shorter ones fill in bursts. */
  readonly paced: boolean;
  /** Recorded pool balance in unbroken stretches, the last ending now; empty until the server has readings. */
  readonly past: ReadonlyArray<readonly RunwayPoint[]>;
  /** Balance ahead at the current burn; at the safe pace while the burn is unknown, or with no more use without a pace. */
  readonly projection: readonly RunwayPoint[];
  readonly refills: ReadonlyArray<{ readonly at: number; readonly percent: number }>;
  /** The first stretch the current burn leaves nothing; null while the burn is unknown. */
  readonly out: { readonly at: number; readonly until: number } | null;
  /**
   * Pool percent per day over the last day; null until some account has a day of readings.
   * A session's is over the last hour, and null unless some account spent in the last 20 minutes.
   */
  readonly burnPerDay: number | null;
  /** The fastest steady burn that never runs out before quota comes back, and the refill that sets it. */
  readonly safe: { readonly perDay: number; readonly until: number } | null;
  /** The burn against the safe pace; null while either is unknown. */
  readonly pace: LimitPace | null;
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
  const accounts: Account[] = [];
  for (const member of pool.members) {
    const { window } = member;
    const cap = 100 * shareOf(pool, member);
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
  let dayLong = false;
  for (const member of pool.members) {
    const { window } = member;
    const samples = readings(window, now);
    if (!samples) return null;
    const base = samples.findLastIndex((sample) => sample.at <= now - DAY);
    dayLong ||= base >= 0;
    const reset = window.resetsAt ? Date.parse(window.resetsAt) : Number.NaN;
    const period = (window.windowDurationMins ?? 0) * MINUTE;
    // A reading is dated to its hour's end, so a reset may fall up to an hour before it.
    const resetBetween = (from: number, to: number) =>
      [1, 2, 3].some((k) => from - HOUR < reset - k * period && reset - k * period <= to);
    let spent = 0;
    // An account first read within the day joined the pool then; what it spent since is the day's.
    for (let index = Math.max(base, 0) + 1; index < samples.length; index++) {
      const previous = samples[index - 1]!;
      const current = samples[index]!;
      spent +=
        current.used < previous.used
          ? resetBetween(previous.at, current.at)
            ? current.used
            : 0
          : current.used - previous.used;
    }
    total += (shareOf(pool, member) * spent) / (base < 0 ? 1 : (now - samples[base]!.at) / DAY);
  }
  return dayLong ? total : null;
}

function recentBurnPerDay(pool: Pool, now: number): number | null {
  let total = 0;
  let inUse = false;
  for (const member of pool.members) {
    if (blocked(member.window)) continue;
    const samples = readings(member.window, now);
    if (!samples) return null;
    const base = Math.max(
      samples.findLastIndex((sample) => sample.at <= now - RECENT),
      0,
    );
    const span = now - samples[base]!.at;
    if (span <= 0) continue;
    let spent = 0;
    for (let index = base + 1; index < samples.length; index++) {
      const previous = samples[index - 1]!;
      const current = samples[index]!;
      // A session's balance only drops back at its reset, when the new session starts from zero.
      const rise = current.used < previous.used ? current.used : current.used - previous.used;
      spent += rise;
      if (rise > 0 && current.at > now - IN_USE) inUse = true;
    }
    total += (shareOf(pool, member) * spent) / (span / DAY);
  }
  return inUse ? total : null;
}

function paceOf(burn: number | null, safe: LimitRunway["safe"]): LimitPace | null {
  if (burn === null || safe === null) return null;
  if (burn > safe.perDay) return "ahead";
  return burn < ROOM * safe.perDay ? "under" : "on";
}

function pastBalance(pool: Pool, from: number, now: number): RunwayPoint[][] {
  // A blocked session's own readings show quota it cannot use, so it counts as empty.
  const byAccount = pool.members.map((member) => ({
    share: shareOf(pool, member),
    samples: blocked(member.window) ? [] : (readings(member.window, now) ?? []).slice(0, -1),
    blocked: blocked(member.window),
  }));
  // An account without readings would draw as empty, not as unknown.
  if (byAccount.some((account) => !account.blocked && account.samples.length === 0)) return [];
  const times = [
    ...new Set(byAccount.flatMap((account) => account.samples.map((sample) => sample.at))),
  ]
    .filter((at) => at >= from && at < now)
    .sort((left, right) => left - right);
  // An account adds its quota from its first reading, when it joined the pool; a missed read keeps its last.
  const remainingAt = (at: number) =>
    byAccount.reduce((sum, account) => {
      const last = account.samples.findLast((sample) => sample.at <= at);
      return sum + (last ? account.share * (100 - last.used) : 0);
    }, 0);
  const points = [
    ...times.map((at) => ({ at, remaining: remainingAt(at) })),
    {
      at: now,
      remaining: pool.members.reduce(
        (sum, member) => sum + shareOf(pool, member) * (100 - member.window.usedPercent),
        0,
      ),
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

/** Spans one window ahead and up to two days back; windows shorter than a day get only a recent burn. */
export function limitRunway(pool: Pool, now: number): LimitRunway | null {
  const accounts = accountsOf(pool, now);
  if (!accounts) return null;
  const period = Math.max(
    ...accounts.flatMap((account) => (Number.isFinite(account.period) ? [account.period] : [])),
  );
  const paced = accounts.every((account) => account.period >= DAY);
  const from = now - Math.min(PAST, period);
  const burn = paced ? burnPerDay(pool, now) : recentBurnPerDay(pool, now);
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
    pace: paceOf(burn, safe),
  };
}
