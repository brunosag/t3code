import type { UsageLimitSourceConfig } from "@t3tools/contracts";
import {
  collectHubLogins,
  collectLimitAccounts,
  collectLimitPools,
  type HubLogin,
  type LimitAccount,
  type LimitPool,
  type LimitPresentations,
  limitRoutingKey,
} from "@t3tools/shared/usageLimits";

/** Saved order first; providers added since it was saved keep their default place at the end. */
export function orderedProviders<P extends string>(
  saved: readonly P[] | undefined,
  defaults: readonly P[],
): readonly P[] {
  return saved ? [...new Set([...saved, ...defaults])] : defaults;
}

/** Swap with the neighbour in `shown`, so a move skips providers that are not on screen. */
export function moveProvider<P extends string>(
  order: readonly P[],
  shown: readonly P[],
  provider: P,
  offset: -1 | 1,
): readonly P[] {
  const index = shown.indexOf(provider);
  const neighbour = index === -1 ? undefined : shown[index + offset];
  if (neighbour === undefined) return order;
  return order.map((entry) =>
    entry === provider ? neighbour : entry === neighbour ? provider : entry,
  );
}

/** Account rows show unless hidden, however many accounts a pool has (upstream needs two). */
export function accountRowsShown<P extends string>(
  provider: P | null | undefined,
  hiddenAccountRows: ReadonlySet<P>,
): boolean {
  return provider == null || !hiddenAccountRows.has(provider);
}

/** Saved entries are replaced whole, so an empty name must drop the key to fall back to the URL. */
export function withHubLabel(source: UsageLimitSourceConfig, name: string): UsageLimitSourceConfig {
  const { label: _previous, ...rest } = source;
  const label = name.trim();
  return label ? { ...rest, label } : rest;
}

/** Routing priorities a reorder expects, by account key, shown until the hub's report agrees. */
export type PendingRouting = ReadonlyMap<string, number>;

function withPendingRouting(
  accounts: readonly LimitAccount[],
  pending: PendingRouting | null,
): readonly LimitAccount[] {
  if (pending === null) return accounts;
  return accounts.map((account) => {
    const priority = pending.get(account.key);
    return priority === undefined || account.routing === null
      ? account
      : { ...account, routing: { ...account.routing, priority } };
  });
}

/** The hub spreads priorities over logins the view hides too, so only their order must agree. */
export function pendingRoutingSettled(
  accounts: readonly LimitAccount[],
  pending: PendingRouting,
): boolean {
  const reported = new Map(accounts.map((account) => [account.key, account] as const));
  const expected = [...pending].flatMap(([key, priority]) => {
    const account = reported.get(key);
    return account?.routing ? [{ account, priority }] : [];
  });
  if (expected.length < pending.size) return true;
  // Priorities only compare within one hub's logins for one provider.
  const group = (account: LimitAccount) => `${account.driver}\n${limitRoutingKey(account)}`;
  return expected.every((left, index) =>
    expected
      .slice(index + 1)
      .every(
        (right) =>
          group(left.account) !== group(right.account) ||
          Math.sign(left.priority - right.priority) ===
            Math.sign(left.account.routing!.priority - right.account.routing!.priority),
      ),
  );
}

/** Moves `activeKey` to `overKey`'s place among its hub's logins, which the pool lists in routing order. */
export function reorderedHubAccounts(
  accounts: readonly LimitAccount[],
  activeKey: string,
  overKey: string,
): readonly LimitAccount[] | null {
  const active = accounts.find((account) => account.key === activeKey);
  const hub = active ? limitRoutingKey(active) : null;
  if (!active || hub === null) return null;
  const hubAccounts = accounts.filter((account) => limitRoutingKey(account) === hub);
  const to = hubAccounts.findIndex((account) => account.key === overKey);
  if (to === -1 || activeKey === overKey) return null;
  const rest = hubAccounts.filter((account) => account !== active);
  return [...rest.slice(0, to), active, ...rest.slice(to)];
}

/** One hub's logins in their new order, highest priority first, as the pending priorities they expect. */
export function pendingRoutingFor(
  previous: PendingRouting | null,
  accounts: readonly LimitAccount[],
): PendingRouting {
  return new Map([
    ...(previous ?? []),
    ...accounts.map((account, index) => [account.key, accounts.length - 1 - index] as const),
  ]);
}

/** Groups one hub's routing of one provider, which "Route by earliest reset" switches. */
const routeByResetKey = (account: LimitAccount) => `${account.driver}\n${limitRoutingKey(account)}`;

/** Hub changes sent but not yet in a report, so the view shows them meanwhile. */
export interface PendingHubChanges {
  readonly routing: PendingRouting | null;
  /** By `HubLogin.key`. */
  readonly disabled: ReadonlyMap<string, boolean>;
  /** By `routeByResetKey`. */
  readonly byReset: ReadonlyMap<string, boolean>;
}

export const NO_PENDING_HUB_CHANGES: PendingHubChanges = {
  routing: null,
  disabled: new Map(),
  byReset: new Map(),
};

/**
 * Pools and hub logins with pending changes laid over the reports. `pending` comes back as the
 * same object while nothing settled; otherwise it drops what the reports now agree with.
 */
export function hubLimitPools(
  presentations: LimitPresentations,
  pending: PendingHubChanges,
  now: number,
) {
  const reportedLogins = collectHubLogins(presentations);
  const disabled = new Map(
    [...pending.disabled].filter(([key, value]) =>
      reportedLogins.some((login) => login.key === key && login.disabled !== value),
    ),
  );
  const hubLogins: readonly HubLogin[] = reportedLogins.map((login) => ({
    ...login,
    disabled: disabled.get(login.key) ?? login.disabled,
  }));
  const collected = collectLimitAccounts(presentations);
  const byReset = new Map(
    [...pending.byReset].filter(([key, value]) =>
      collected.some(
        (account) => routeByResetKey(account) === key && account.routing?.byReset !== value,
      ),
    ),
  );
  const reported = collected.map((account) => {
    const accountDisabled =
      account.routing && account.environments.length === 0
        ? disabled.get(
            `${account.routing.environmentId}:${account.routing.sourceId}:${account.routing.accountId}`,
          )
        : undefined;
    const accountByReset = byReset.get(routeByResetKey(account));
    const routing =
      accountByReset === undefined || account.routing === null
        ? account.routing
        : { ...account.routing, byReset: accountByReset };
    return accountDisabled === undefined && routing === account.routing
      ? account
      : { ...account, routing, disabled: accountDisabled ?? account.disabled };
  });
  // An optimistic order never outlives the hub report it was for.
  const routing =
    pending.routing !== null && pendingRoutingSettled(reported, pending.routing)
      ? null
      : pending.routing;
  const reportedPools = collectLimitPools(withPendingRouting(reported, routing), now);
  // A provider with hub logins but no readings keeps its section, so its menu can turn one on.
  const unreadPools = [...new Set(hubLogins.map((login) => login.driver))].flatMap(
    (driver): LimitPool[] =>
      reportedPools.some((pool) => pool.driver === driver)
        ? []
        : [{ driver, accounts: [], windows: [] }],
  );
  const settled =
    routing === pending.routing &&
    disabled.size === pending.disabled.size &&
    byReset.size === pending.byReset.size
      ? pending
      : { routing, disabled, byReset };
  return { pools: [...reportedPools, ...unreadPools], hubLogins, pending: settled };
}

/** The hubs whose routing of `pool`'s provider the viewer may switch; null with fewer than two such logins. */
export function routeByResetHubs(pool: LimitPool, mayRoute: (account: LimitAccount) => boolean) {
  const routable = pool.accounts.flatMap((account) =>
    account.routing && mayRoute(account)
      ? [[routeByResetKey(account), account.routing] as const]
      : [],
  );
  if (routable.length < 2) return null;
  const hubs = new Map(routable);
  return { on: [...hubs.values()].every((routing) => routing.byReset), hubs };
}

export interface HubListing {
  readonly label: string;
  readonly logins: readonly HubLogin[];
  /** Every machine's entry for this hub, so a rename can reach each. */
  readonly sources: ReadonlyArray<Pick<HubLogin, "environmentId" | "sourceId">>;
}

/** One provider's logins by hub; machines reading the same hub report the same login files, so it is listed once. */
export function listHubs(logins: readonly HubLogin[]): readonly HubListing[] {
  const hubs = new Map<string, { label: string; name: string; logins: HubLogin[] }>();
  for (const login of logins) {
    const key = `${login.environmentId}:${login.sourceId}`;
    const hub = hubs.get(key) ?? { label: login.hubLabel, name: login.hubName, logins: [] };
    hub.logins.push(login);
    hubs.set(key, hub);
  }
  const loginFiles = (hubLogins: readonly HubLogin[]) =>
    hubLogins
      .map((login) => login.accountId)
      .sort()
      .join("\n");
  const listed: { label: string; name: string; logins: HubLogin[]; sources: HubLogin[] }[] = [];
  for (const hub of hubs.values()) {
    const same = listed.find((seen) => loginFiles(seen.logins) === loginFiles(hub.logins));
    if (!same) {
      listed.push({ ...hub, sources: [hub.logins[0]!] });
      continue;
    }
    if (same.name === hub.name) same.label = hub.name;
    same.sources.push(hub.logins[0]!);
    same.logins = same.logins.map((login) => {
      const other = hub.logins.find((candidate) => candidate.accountId === login.accountId);
      return {
        ...login,
        name: login.name ?? other?.name ?? null,
        image: login.image ?? other?.image,
      };
    });
  }
  return listed.map(({ label, logins: hubLogins, sources }) => ({
    label,
    logins: hubLogins,
    sources: sources.map(({ environmentId, sourceId }) => ({ environmentId, sourceId })),
  }));
}
