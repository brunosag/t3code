import { EnvironmentId, ProviderDriverKind, UsageLimitSourceId } from "@t3tools/contracts";
import type { LimitAccount } from "@t3tools/shared/usageLimits";
import { describe, expect, it } from "vite-plus/test";

import { pendingRoutingSettled, reorderedHubAccounts } from "./usageRouting";

const account = (key: string, priority: number | null, sourceId = "hub"): LimitAccount => ({
  key,
  driver: ProviderDriverKind.make("codex"),
  displayName: key,
  email: undefined,
  plan: undefined,
  capacity: undefined,
  accentColor: undefined,
  image: undefined,
  environments: [],
  sourceLabel: "Hub",
  redeem: null,
  routing:
    priority === null
      ? null
      : {
          environmentId: EnvironmentId.make("env"),
          sourceId: UsageLimitSourceId.make(sourceId),
          accountId: key,
          priority,
          byReset: false,
        },
  disabled: false,
  stale: false,
  limits: { checkedAt: "2026-11-08T00:00:00.000Z", windows: [] },
});

describe("hub routing order", () => {
  it.each([
    ["the reported order matches with an offset", [5, 4, 3], true],
    ["the report still ties two of them", [1, 1, 0], false],
    ["the report is the old order", [0, 1, 2], false],
  ] as const)("is settled only when %s", (_case, reported, settled) => {
    const accounts = ["a", "b", "c"].map((key, index) => account(key, reported[index]!));
    const pending = new Map([
      ["a", 2],
      ["b", 1],
      ["c", 0],
    ]);
    expect(pendingRoutingSettled(accounts, pending)).toBe(settled);
  });

  it("settles a balance only when priorities tie, compares within one hub, and drops a vanished login", () => {
    const balanced = new Map([
      ["a", 0],
      ["b", 0],
    ]);
    expect(pendingRoutingSettled([account("a", 1), account("b", 0)], balanced)).toBe(false);
    expect(pendingRoutingSettled([account("a", 3), account("b", 3)], balanced)).toBe(true);
    expect(pendingRoutingSettled([account("a", 1)], balanced)).toBe(true);
    const otherHub = new Map([
      ["a", 1],
      ["b", 0],
      ["x", 0],
    ]);
    expect(
      pendingRoutingSettled(
        [account("a", 4), account("b", 3), account("x", 9, "second")],
        otherHub,
      ),
    ).toBe(true);
  });

  it("moves a login within its own hub and never onto another hub or a native login", () => {
    const pool = [
      account("a", 2),
      account("b", 1),
      account("c", 0),
      account("other", 0, "second-hub"),
      account("native", null),
    ];
    expect(reorderedHubAccounts(pool, "c", "a")?.map((entry) => entry.key)).toEqual([
      "c",
      "a",
      "b",
    ]);
    expect(reorderedHubAccounts(pool, "a", "b")?.map((entry) => entry.key)).toEqual([
      "b",
      "a",
      "c",
    ]);
    expect(reorderedHubAccounts(pool, "a", "other")).toBeNull();
    expect(reorderedHubAccounts(pool, "a", "native")).toBeNull();
    expect(reorderedHubAccounts(pool, "native", "a")).toBeNull();
  });
});
