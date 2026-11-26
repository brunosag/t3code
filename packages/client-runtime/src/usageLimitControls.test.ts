import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProviderDriverKind,
  UsageLimitSourceId,
} from "@t3tools/contracts";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";
import type { LimitAccount, LimitPresentations } from "@t3tools/shared/usageLimits";
import { describe, expect, it } from "vite-plus/test";

import {
  accountRowsShown,
  hubLimitPools,
  listHubs,
  moveProvider,
  NO_PENDING_HUB_CHANGES,
  orderedProviders,
  pendingRoutingSettled,
  reorderedHubAccounts,
  withHubLabel,
} from "./usageLimitControls.ts";

const DEFAULT_ORDER = ["codex", "claude", "grok", "cursor", "antigravity"] as const;

describe("account rows", () => {
  it("show unless their provider hides them", () => {
    expect(accountRowsShown("claude", new Set())).toBe(true);
    expect(accountRowsShown("claude", new Set(["codex"]))).toBe(true);
    expect(accountRowsShown("claude", new Set(["claude"]))).toBe(false);
    expect(accountRowsShown(null, new Set(["claude"]))).toBe(true);
  });
});

describe("usage provider order", () => {
  it("keeps providers missing from a saved order at the end", () => {
    expect(orderedProviders(["antigravity", "claude"], DEFAULT_ORDER)).toEqual([
      "antigravity",
      "claude",
      "codex",
      "grok",
      "cursor",
    ]);
    expect(orderedProviders(undefined, DEFAULT_ORDER)).toBe(DEFAULT_ORDER);
  });

  it("moves past providers that are not shown", () => {
    const order = ["codex", "claude", "grok", "antigravity"] as const;
    expect(moveProvider(order, ["codex", "antigravity"], "antigravity", -1)).toEqual([
      "antigravity",
      "claude",
      "grok",
      "codex",
    ]);
    expect(moveProvider(order, ["codex", "antigravity"], "codex", -1)).toBe(order);
    expect(moveProvider(order, ["codex", "antigravity"], "antigravity", 1)).toBe(order);
  });
});

describe("hub names", () => {
  it("renames a hub and clears the name back to its URL", () => {
    const id = UsageLimitSourceId.make("cliproxy-proxy.test");
    const saved = {
      kind: "cliproxy",
      url: "http://proxy.test:8318",
      label: "Claude Pool",
      managementKey: "key",
      enabled: true,
      accounts: { "codex-1": { name: "Personal" } },
    } as const;
    let settings = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      usageLimitSources: { [id]: saved },
    });
    const rename = (name: string) =>
      applyServerSettingsPatch(settings, {
        usageLimitSources: { [id]: withHubLabel(settings.usageLimitSources[id]!, name) },
      });
    settings = rename(" VPS hub ");
    expect(settings.usageLimitSources[id]).toEqual({ ...saved, label: "VPS hub" });
    settings = rename("  ");
    const { label: _label, ...unnamed } = saved;
    expect(settings.usageLimitSources[id]).toEqual(unnamed);
  });
});

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

describe("hub logins", () => {
  const checkedAt = "2026-11-08T00:00:00.000Z";
  const codex = ProviderDriverKind.make("codex");
  const login = (id: string, extra: { disabled?: boolean; name?: string } = {}) => ({
    id,
    driver: codex,
    email: `${id}@example.com`,
    priority: 0,
    ...extra,
    usageLimits: {
      checkedAt,
      windows: [{ id: "5h", kind: "session" as const, label: "5h", usedPercent: 10 }],
    },
  });
  const machine = (
    label: string,
    hubLabel: string,
    accounts: readonly ReturnType<typeof login>[],
  ) => ({
    entry: { target: { label } },
    serverConfig: {
      providers: [],
      usageLimitSources: [
        {
          id: UsageLimitSourceId.make("hub"),
          kind: "cliproxy" as const,
          label: hubLabel,
          checkedAt,
          accounts,
        },
      ],
    },
  });

  it("lists a hub several machines read once, under its own name when they agree", () => {
    const presentations: LimitPresentations = new Map([
      [EnvironmentId.make("laptop"), machine("Laptop", "Pool", [login("a"), login("b")])],
      [
        EnvironmentId.make("vps"),
        machine("VPS", "Pool", [login("b", { name: "Work" }), login("a")]),
      ],
      [EnvironmentId.make("other"), machine("Other", "Other pool", [login("c")])],
    ]);
    const { hubLogins } = hubLimitPools(
      presentations,
      NO_PENDING_HUB_CHANGES,
      Date.parse(checkedAt),
    );
    const hubs = listHubs(hubLogins);
    expect(
      hubs.map((hub) => ({
        label: hub.label,
        logins: hub.logins.map((entry) => entry.name ?? entry.accountId),
        sources: hub.sources.map((source) => source.environmentId),
      })),
    ).toEqual([
      { label: "Pool", logins: ["a", "Work"], sources: ["laptop", "vps"] },
      { label: "Other · Other pool", logins: ["c"], sources: ["other"] },
    ]);
  });

  it("shows a switched-off login as off until the hub reports it, then drops the pending change", () => {
    const now = Date.parse(checkedAt);
    const pending = {
      ...NO_PENDING_HUB_CHANGES,
      disabled: new Map([["laptop:hub:b", true]]),
    };
    const before = new Map([
      [EnvironmentId.make("laptop"), machine("Laptop", "Pool", [login("a"), login("b")])],
    ]);
    const shown = hubLimitPools(before, pending, now);
    expect(shown.pending).toBe(pending);
    expect(shown.hubLogins.map((entry) => entry.disabled)).toEqual([false, true]);
    expect(shown.pools[0]?.windows[0]?.members.map((member) => member.account.email)).toEqual([
      "a@example.com",
    ]);
    expect(shown.pools[0]?.windows[0]?.offMembers.map((member) => member.account.email)).toEqual([
      "b@example.com",
    ]);

    const after = new Map([
      [
        EnvironmentId.make("laptop"),
        machine("Laptop", "Pool", [login("a"), login("b", { disabled: true })]),
      ],
    ]);
    expect(hubLimitPools(after, pending, now).pending.disabled.size).toBe(0);
  });

  it("keeps a provider whose every hub login is off, so it can be switched back on", () => {
    const presentations = new Map([
      [EnvironmentId.make("laptop"), machine("Laptop", "Pool", [login("a", { disabled: true })])],
    ]);
    const { pools } = hubLimitPools(presentations, NO_PENDING_HUB_CHANGES, Date.parse(checkedAt));
    expect(pools.map((pool) => [pool.driver, pool.windows.length])).toEqual([["codex", 0]]);
  });
});
