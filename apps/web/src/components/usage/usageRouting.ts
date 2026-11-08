import { type LimitAccount, limitRoutingKey } from "@t3tools/shared/usageLimits";

/** Routing priorities a reorder expects, by account key, shown until the hub's report agrees. */
export type PendingRouting = ReadonlyMap<string, number>;

export function withPendingRouting(
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
