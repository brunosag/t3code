import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type UsageLimitSourceAccount,
  UsageLimitSourceId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  type LimitAccount,
  displayLimitWindows,
  cursorUsageWindowDetails,
  collectProviderUsageLimits,
  sameUsageLimitCommandCoverage,
  withUsageLimitsCommands,
  collectLimitAccounts,
  collectExternalUsageLinks,
  collectLimitPools,
  elapsedShare,
  exhaustedUsageWindow,
  paceOf,
  paceRemainingPercent,
  usesChatGptSharing,
  resolveNewThreadModelSelection,
  bankedResets,
  staleLimitAccounts,
} from "./usageLimits.ts";
import { collectLimitNotices, resetCreditChoices } from "./usageLimitsCopy.ts";

const now = Date.parse("2026-09-03T12:00:00.000Z");

const window = {
  id: "five_hour",
  kind: "session",
  label: "Session",
  usedPercent: 40,
  windowDurationMins: 300,
  resetsAt: "2026-09-03T14:00:00.000Z",
} as const;

function provider(overrides: Partial<ServerProvider>): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("codex"),
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-09-03T11:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    ...overrides,
  };
}

describe("new thread model fallback", () => {
  const selection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" };
  const fallback = { instanceId: ProviderInstanceId.make("claude"), model: "claude-fable-5-1" };
  const limited = provider({
    usageLimits: {
      checkedAt: "2026-09-03T11:00:00.000Z",
      windows: [{ ...window, usedPercent: 100 }],
    },
  });
  const available = provider({
    instanceId: fallback.instanceId,
    driver: ProviderDriverKind.make("claudeAgent"),
  });

  const defaults = {
    defaultSelection: selection,
    fallbackSelection: fallback,
    providers: [limited, available],
    now,
  };
  it.each([
    ["exhausted default", {}, fallback],
    ["explicit selection", { explicitSelection: selection }, selection],
    ["missing default", { defaultSelection: null }, null],
    ["no fallback", { fallbackSelection: null }, selection],
    ["expired window", { now: Date.parse("2026-09-04T00:00:00Z") }, selection],
    [
      "environment disabled",
      {
        settings: {
          ...DEFAULT_SERVER_SETTINGS,
          providerInstances: {
            [fallback.instanceId]: { driver: available.driver, enabled: false, config: {} },
          },
        },
      },
      selection,
    ],
  ] as const)("resolves %s", (_name, overrides, expected) => {
    expect(resolveNewThreadModelSelection({ ...defaults, ...overrides }).selection).toEqual(
      expected,
    );
  });
  it.each([
    { enabled: false },
    { installed: false },
    { auth: { status: "unauthenticated" as const } },
    { availability: "unavailable" as const },
    { usageLimits: limited.usageLimits },
  ])("rejects an unusable fallback: %j", (overrides) => {
    expect(
      resolveNewThreadModelSelection({
        ...defaults,
        providers: [limited, { ...available, ...overrides }],
      }).selection,
    ).toEqual(selection);
  });
  it.each([undefined, "invalid"])("treats an unknown reset as exhausted: %s", (resetsAt) => {
    expect(
      exhaustedUsageWindow(
        provider({
          usageLimits: {
            checkedAt: limited.checkedAt,
            windows: [{ ...window, usedPercent: 100, resetsAt }],
          },
        }),
        now,
      ),
    ).toBeDefined();
  });
  it.each([
    ["cursor", ["autoPercentUsed"], "claude-opus-5-5", false, undefined, undefined],
    ["cursor", ["autoPercentUsed"], "composer-2.5", false, undefined, undefined],
    ["cursor", ["autoPercentUsed", "apiPercentUsed"], "composer-2.5", true, undefined, undefined],
    ["antigravity", ["gemini-weekly"], "claude-opus-5-5", false, undefined, undefined],
    ["antigravity", ["3p-weekly"], "claude-opus-5-5", true, undefined, undefined],
    ["antigravity", ["gemini-weekly"], "antigravity-default", true, undefined, undefined],
    ["codex", ["individual"], "gpt-5.5", true, undefined, undefined],
    ["opencode", ["go_weekly"], "opencode/big-pickle", false, undefined, undefined],
    ["opencode", ["go_weekly"], "opencode-go/big-pickle", true, undefined, undefined],
    ["opencode", ["budget_model"], "opencode/other", false, ["opencode/limited"], undefined],
    ["opencode", ["budget_model"], "opencode/limited", true, ["opencode/limited"], undefined],
    [
      "opencode",
      ["budget_set"],
      "other/model",
      false,
      ["opencode/limited", "opencode/second"],
      undefined,
    ],
    [
      "opencode",
      ["budget_set"],
      "opencode/second",
      true,
      ["opencode/limited", "opencode/second"],
      undefined,
    ],
    ["opencode", ["budget_empty"], "opencode/other", false, [], undefined],
    [
      "opencode",
      ["budget_all"],
      "anthropic/claude",
      false,
      undefined,
      ["opencode", "console-custom"],
    ],
    [
      "opencode",
      ["budget_all"],
      "opencode-go/model",
      false,
      undefined,
      ["opencode", "console-custom"],
    ],
    ["opencode", ["budget_all"], "opencode/model", true, undefined, ["opencode", "console-custom"]],
    [
      "opencode",
      ["budget_all"],
      "console-custom/model",
      true,
      undefined,
      ["opencode", "console-custom"],
    ],
    ["opencode", ["budget_all"], "opencode/model", false, undefined, []],
  ] as const)(
    "matches %s pools %s to %s",
    (driver, ids, model, usesFallback, modelIds, providerIds) => {
      const defaultSelection = { ...selection, model };
      expect(
        resolveNewThreadModelSelection({
          ...defaults,
          defaultSelection,
          providers: [
            provider({
              driver: ProviderDriverKind.make(driver),
              usageLimits: {
                checkedAt: limited.checkedAt,
                windows: ids.map((id) => ({
                  ...window,
                  id,
                  usedPercent: 100,
                  ...(modelIds === undefined ? {} : { modelIds }),
                  ...(providerIds === undefined ? {} : { providerIds }),
                })),
              },
            }),
            available,
          ],
        }).selection,
      ).toEqual(usesFallback ? fallback : defaultSelection);
    },
  );
});

describe("pace", () => {
  it("places the clock three fifths through a five-hour window with two hours left", () => {
    expect(elapsedShare(window, now)).toBeCloseTo(0.6);
    expect(paceRemainingPercent(window, now)).toBe(40);
    expect(paceOf(window, now)).toBe("under");
    expect(paceOf({ ...window, usedPercent: 62 }, now)).toBe("on");
    expect(paceOf({ ...window, usedPercent: 80 }, now)).toBe("ahead");
  });
});

describe("pools", () => {
  const checkedAt = "2026-09-03T11:00:00.000Z";
  const weekly = {
    id: "seven_day",
    kind: "weekly",
    label: "Weekly",
    windowDurationMins: 7 * 24 * 60,
    resetsAt: "2026-09-06T12:00:00.000Z",
  } as const;
  const claude = ProviderDriverKind.make("claudeAgent");
  const source = {
    id: UsageLimitSourceId.make("hub"),
    kind: "cliproxy" as const,
    label: "hub",
    checkedAt,
  };
  const laptop = { entry: { target: { label: "Laptop" } } };

  it("merges one account reported natively on two environments and by a hub into one entry", () => {
    const native = provider({
      driver: claude,
      instanceId: ProviderInstanceId.make("claude"),
      auth: { status: "authenticated", email: "Same@example.com" },
      usageLimits: { checkedAt, windows: [{ ...window, usedPercent: 40 }] },
    });
    const input = new Map([
      [EnvironmentId.make("env-a"), { ...laptop, serverConfig: { providers: [native] } }],
      [
        EnvironmentId.make("env-b"),
        {
          entry: { target: { label: "Desktop" } },
          serverConfig: {
            providers: [
              {
                ...native,
                usageLimits: {
                  checkedAt: "2026-09-03T11:30:00.000Z",
                  windows: [{ ...window, usedPercent: 55 }],
                },
              },
            ],
            usageLimitSources: [
              {
                ...source,
                accounts: [
                  {
                    id: "claude-same@example.com.json",
                    driver: claude,
                    email: "same@example.com",
                    plan: "Claude Subscription",
                    usageLimits: { checkedAt, windows: [{ ...window, usedPercent: 10 }] },
                  },
                ],
              },
            ],
          },
        },
      ],
    ]);
    const accounts = collectLimitAccounts(input);
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({
      key: "env-a:claude",
      sourceLabel: null,
      redeem: { environmentId: "env-b", input: { instanceId: "claude" } },
      environments: [
        { environmentId: "env-a", label: "Laptop" },
        { environmentId: "env-b", label: "Desktop" },
      ],
    });
    expect(accounts[0]?.limits.windows[0]?.usedPercent).toBe(55);
  });

  it("names a hub account with its saved name and image, also when an unnamed login matches it", () => {
    const image = "data:image/webp;base64,AAAA";
    const native = provider({
      driver: claude,
      instanceId: ProviderInstanceId.make("claude"),
      auth: { status: "authenticated", email: "same@example.com" },
      usageLimits: { checkedAt, windows: [window] },
    });
    const hubAccount = (id: string, email: string) => ({
      id,
      driver: claude,
      email,
      usageLimits: { checkedAt, windows: [window] },
    });
    const accounts = collectLimitAccounts(
      new Map([
        [
          EnvironmentId.make("env-a"),
          {
            ...laptop,
            serverConfig: {
              providers: [native],
              usageLimitSources: [
                {
                  ...source,
                  accounts: [
                    { ...hubAccount("same.json", "same@example.com"), name: "Work", image },
                    hubAccount("other.json", "other@example.com"),
                  ],
                },
              ],
            },
          },
        ],
      ]),
    );
    expect(
      accounts.map(({ email, displayName, image }) => ({ email, displayName, image })),
    ).toEqual([
      { email: "same@example.com", displayName: "Work", image },
      { email: "other@example.com", displayName: null, image: undefined },
    ]);
  });

  it("uses the freshest reported plan even when the newest quota has no plan", () => {
    const snapshot = (label: string | undefined, checkedAt: string, usedPercent: number) =>
      provider({
        driver: claude,
        auth: { status: "authenticated", email: "same@example.com", label },
        usageLimits: { checkedAt, windows: [{ ...window, usedPercent }] },
      });
    const stale = snapshot("Claude Team Subscription", checkedAt, 40);
    const fresh = snapshot("Claude Max Subscription", "2026-09-03T11:30:00.000Z", 7);
    const newest = snapshot(undefined, "2026-09-03T12:00:00.000Z", 5);
    for (const [reports, plan, usedPercent] of [
      [[stale, fresh], "Claude Max Subscription", 7],
      [[stale, newest], "Claude Team Subscription", 5],
      [[stale, fresh, newest], "Claude Max Subscription", 5],
    ] as const) {
      for (const order of reports.length === 2
        ? [reports, reports.toReversed()]
        : [
            [stale, fresh, newest],
            [stale, newest, fresh],
            [fresh, stale, newest],
            [fresh, newest, stale],
            [newest, stale, fresh],
            [newest, fresh, stale],
          ]) {
        const accounts = collectLimitAccounts(
          new Map(
            order.map((entry, index) => [
              EnvironmentId.make(`env-${index}`),
              { ...laptop, serverConfig: { providers: [entry] } },
            ]),
          ),
        );
        expect(accounts).toHaveLength(1);
        expect(accounts[0]?.plan).toBe(plan);
        expect(accounts[0]?.limits.windows[0]?.usedPercent).toBe(usedPercent);
      }
    }
  });

  it("merges OpenCode Go limits from machines with the same API key", () => {
    const go = provider({
      driver: ProviderDriverKind.make("opencode"),
      instanceId: ProviderInstanceId.make("opencode"),
      auth: { status: "authenticated" },
      usageLimits: {
        checkedAt,
        credentialFingerprint: "shared-go-key",
        windows: [{ ...window, id: "go_rolling", usedPercent: 3 }],
      },
    });
    const input = new Map([
      [EnvironmentId.make("env-a"), { ...laptop, serverConfig: { providers: [go] } }],
      [
        EnvironmentId.make("env-b"),
        {
          entry: { target: { label: "Desktop" } },
          serverConfig: {
            providers: [
              {
                ...go,
                usageLimits: {
                  ...go.usageLimits!,
                  checkedAt: "2026-09-03T11:30:00.000Z",
                  windows: [{ ...window, id: "go_rolling", usedPercent: 4 }],
                },
              },
            ],
          },
        },
      ],
    ]);
    const accounts = collectLimitAccounts(input);
    expect(accounts).toHaveLength(1);
    expect(accounts[0]?.environments).toEqual([
      { environmentId: "env-a", label: "Laptop" },
      { environmentId: "env-b", label: "Desktop" },
    ]);
    expect(collectLimitPools(accounts, now)[0]?.windows[0]?.members).toHaveLength(1);
    expect(accounts[0]?.limits.windows[0]?.usedPercent).toBe(4);

    const differentKey = {
      ...go,
      usageLimits: { ...go.usageLimits!, credentialFingerprint: "other-go-key" },
    };
    input.set(EnvironmentId.make("env-b"), {
      entry: { target: { label: "Desktop" } },
      serverConfig: { providers: [differentKey] },
    });
    expect(collectLimitAccounts(input)).toHaveLength(2);

    input.set(EnvironmentId.make("env-a"), {
      ...laptop,
      serverConfig: {
        providers: [{ ...go, auth: { status: "authenticated", email: "same@example.com" } }],
      },
    });
    input.set(EnvironmentId.make("env-b"), {
      entry: { target: { label: "Desktop" } },
      serverConfig: {
        providers: [
          { ...differentKey, auth: { status: "authenticated", email: "SAME@example.com" } },
        ],
      },
    });
    expect(collectLimitAccounts(input)).toHaveLength(1);
  });

  it("merges a local Antigravity login with its hub account by Google account fingerprint", () => {
    const antigravity = ProviderDriverKind.make("antigravity");
    const local = provider({
      driver: antigravity,
      instanceId: ProviderInstanceId.make("antigravity"),
      auth: { status: "authenticated", label: "Google account" },
      usageLimits: {
        checkedAt: "2026-09-03T11:30:00.000Z",
        credentialFingerprint: "google-key",
        windows: [{ ...window, id: "gemini-weekly", usedPercent: 20 }],
      },
    });
    const hubAccount = {
      id: "antigravity-g@example.com.json",
      driver: antigravity,
      plan: "Google AI Ultra 5x",
      capacity: 5,
      usageLimits: {
        checkedAt,
        credentialFingerprint: "google-key",
        windows: [{ ...window, id: "gemini-weekly", usedPercent: 30 }],
      },
    };
    const accounts = collectLimitAccounts(
      new Map([
        [
          EnvironmentId.make("env-a"),
          {
            ...laptop,
            serverConfig: {
              providers: [local],
              usageLimitSources: [{ ...source, accounts: [hubAccount] }],
            },
          },
        ],
      ]),
    );
    expect(accounts).toHaveLength(1);
    // The fresher local reading wins, but the hub's sized plan beats the local sign-in label.
    expect(accounts[0]).toMatchObject({ plan: "Google AI Ultra 5x", capacity: 5 });
    expect(accounts[0]?.limits.windows[0]?.usedPercent).toBe(20);
  });

  it("takes windows from a fresher hub read but credits and redeem from the native instance", () => {
    const native = provider({
      driver: claude,
      instanceId: ProviderInstanceId.make("claude"),
      auth: { status: "authenticated", email: "same@example.com" },
      usageLimits: {
        checkedAt,
        windows: [{ ...window, usedPercent: 40 }],
        resetCredits: { availableCount: 2 },
      },
    });
    const input = new Map([
      [
        EnvironmentId.make("env-a"),
        {
          ...laptop,
          serverConfig: {
            providers: [native],
            usageLimitSources: [
              {
                ...source,
                accounts: [
                  {
                    id: "claude-same@example.com.json",
                    driver: claude,
                    email: "same@example.com",
                    usageLimits: {
                      checkedAt: "2026-09-03T11:30:00.000Z",
                      windows: [{ ...window, usedPercent: 55 }],
                    },
                  },
                ],
              },
            ],
          },
        },
      ],
    ]);
    const [account] = collectLimitAccounts(input);
    expect(account?.limits.windows[0]?.usedPercent).toBe(55);
    expect(account?.limits.resetCredits?.availableCount).toBe(2);
    expect(account?.redeem).toEqual({ environmentId: "env-a", input: { instanceId: "claude" } });
    expect(account?.environments).toEqual([{ environmentId: "env-a", label: "Laptop" }]);
  });

  it("redeems through the hub when it holds a credit, even with a fresher native read", () => {
    const native = provider({
      driver: claude,
      instanceId: ProviderInstanceId.make("claude"),
      auth: { status: "authenticated", email: "same@example.com" },
      usageLimits: {
        checkedAt: "2026-09-03T11:30:00.000Z",
        windows: [{ ...window, usedPercent: 40 }],
        resetCredits: { availableCount: 3, nextCreditId: "native-credit" },
      },
    });
    const input = new Map([
      [
        EnvironmentId.make("env-a"),
        {
          ...laptop,
          serverConfig: {
            providers: [native],
            usageLimitSources: [
              {
                ...source,
                accounts: [
                  {
                    id: "claude-same@example.com.json",
                    driver: claude,
                    email: "same@example.com",
                    usageLimits: {
                      checkedAt,
                      windows: [{ ...window, usedPercent: 55 }],
                      resetCredits: { availableCount: 2, nextCreditId: "hub-credit" },
                    },
                  },
                ],
              },
            ],
          },
        },
      ],
    ]);
    const [account] = collectLimitAccounts(input);
    expect(account?.redeem).toEqual({
      environmentId: "env-a",
      input: { sourceId: "hub", accountId: "claude-same@example.com.json", creditId: "hub-credit" },
    });
    expect(account?.limits.resetCredits?.availableCount).toBe(3);
  });

  it("redeems on the environment whose snapshot supplied the credits on show", () => {
    const stale = provider({
      auth: { status: "authenticated", email: "same@example.com" },
      usageLimits: {
        checkedAt,
        windows: [window],
        resetCredits: { availableCount: 0 },
      },
    });
    const fresh = {
      ...stale,
      usageLimits: {
        checkedAt: "2026-09-03T11:30:00.000Z",
        windows: [window],
        resetCredits: { availableCount: 2 },
      },
    };
    const input = new Map([
      [EnvironmentId.make("env-a"), { ...laptop, serverConfig: { providers: [stale] } }],
      [
        EnvironmentId.make("env-b"),
        { entry: { target: { label: "Desktop" } }, serverConfig: { providers: [fresh] } },
      ],
    ]);
    const [account] = collectLimitAccounts(input);
    expect(account?.limits.resetCredits?.availableCount).toBe(2);
    expect(account?.redeem).toEqual({ environmentId: "env-b", input: { instanceId: "codex" } });
  });

  it("keeps distinct hub accounts redeemable through their own source, flagging carried readings", () => {
    const hubAccounts = ["first", "second"].map((id) => ({
      id,
      driver: ProviderDriverKind.make("codex"),
      email: `${id}@example.com`,
      usageLimits: {
        // The hub's read of the second login failed, so it carries an earlier reading.
        checkedAt: id === "second" ? "2026-09-03T10:40:00.000Z" : checkedAt,
        windows: [window],
        resetCredits: { availableCount: 2, nextCreditId: `${id}-credit` },
      },
    }));
    const input = new Map([
      [
        EnvironmentId.make("env-a"),
        {
          ...laptop,
          serverConfig: {
            providers: [],
            usageLimitSources: [{ ...source, accounts: hubAccounts }],
          },
        },
      ],
    ]);
    expect(collectLimitAccounts(input).map((account) => account.redeem)).toEqual(
      hubAccounts.map((account) => ({
        environmentId: "env-a",
        input: { sourceId: "hub", accountId: account.id, creditId: `${account.id}-credit` },
      })),
    );
    expect(collectLimitAccounts(input).map((account) => account.stale)).toEqual([false, true]);
    // A missed read or two is routine; only an older carried reading gets a notice.
    const noted = (at: string) =>
      staleLimitAccounts(collectLimitAccounts(input), Date.parse(at)).map((account) => account.key);
    expect(noted("2026-09-03T10:49:00.000Z")).toEqual([]);
    expect(noted("2026-09-03T10:50:00.000Z")).toEqual([expect.stringContaining("second")]);
  });

  it("does not give old credits the timestamp of a newer window-only read", () => {
    const snapshots = [
      { checkedAt, windows: [window], resetCredits: { availableCount: 2 } },
      { checkedAt: "2026-09-03T12:00:00.000Z", windows: [window] },
      {
        checkedAt: "2026-09-03T11:30:00.000Z",
        windows: [window],
        resetCredits: { availableCount: 1 },
      },
    ];
    const input = new Map(
      snapshots.map((usageLimits, i) => [
        EnvironmentId.make(`env-${i}`),
        {
          ...laptop,
          serverConfig: {
            providers: [
              provider({
                auth: { status: "authenticated", email: "same@example.com" },
                usageLimits,
              }),
            ],
          },
        },
      ]),
    );
    const [account] = collectLimitAccounts(input);
    expect(account?.limits.checkedAt).toBe("2026-09-03T12:00:00.000Z");
    expect(account?.limits.resetCredits?.availableCount).toBe(1);
    expect(account?.redeem?.environmentId).toBe("env-2");
  });

  it("keeps one email in two workspaces apart while merging each workspace's duplicates", () => {
    const login = (instanceId: string, workspaceId: string, usedPercent: number) =>
      provider({
        instanceId: ProviderInstanceId.make(instanceId),
        auth: { status: "authenticated", email: "same@example.com", workspaceId },
        usageLimits: { checkedAt, windows: [{ ...weekly, usedPercent }] },
      });
    const hubAccount = (id: string, workspaceId?: string) => ({
      id,
      driver: ProviderDriverKind.make("codex"),
      email: "same@example.com",
      ...(workspaceId ? { workspaceId } : {}),
      usageLimits: { checkedAt, windows: [{ ...weekly, usedPercent: 50 }] },
    });
    const input = new Map([
      [
        EnvironmentId.make("env-a"),
        {
          ...laptop,
          serverConfig: {
            providers: [login("business", "ws-business", 8), login("personal", "ws-plus", 26)],
            usageLimitSources: [
              { ...source, accounts: [hubAccount("plus.json", "ws-plus"), hubAccount("x.json")] },
            ],
          },
        },
      ],
      [
        EnvironmentId.make("env-b"),
        {
          entry: { target: { label: "Desktop" } },
          serverConfig: { providers: [login("personal", "ws-plus", 26)] },
        },
      ],
    ]);
    const accounts = collectLimitAccounts(input);
    expect(accounts.map((account) => account.key)).toEqual([
      "env-a:business",
      "env-a:personal",
      "env-a:hub:x.json",
    ]);
    expect(accounts[0]?.limits.windows[0]?.usedPercent).toBe(8);
    const withoutEmail = (id: string, workspaceId: string) => {
      const { email: _email, ...account } = hubAccount(id, workspaceId);
      return account;
    };
    const sameFile = new Map([
      [
        EnvironmentId.make("env-a"),
        {
          ...laptop,
          serverConfig: {
            providers: [],
            usageLimitSources: [{ ...source, accounts: [withoutEmail("a.json", "ws-1")] }],
          },
        },
      ],
      [
        EnvironmentId.make("env-b"),
        {
          ...laptop,
          serverConfig: {
            providers: [],
            usageLimitSources: [{ ...source, accounts: [withoutEmail("a.json", "ws-2")] }],
          },
        },
      ],
    ]);
    expect(collectLimitAccounts(sameFile).map((account) => account.key)).toEqual([
      "env-a:hub:a.json:ws-1",
      "env-b:hub:a.json:ws-2",
    ]);
    expect(accounts[1]?.environments.map((environment) => environment.label)).toEqual([
      "Laptop",
      "Desktop",
    ]);
  });

  it("joins a report without a workspace to the only workspace signed in with its email", () => {
    const native = provider({
      driver: claude,
      auth: { status: "authenticated", email: "same@example.com", workspaceId: "org-a" },
      usageLimits: { checkedAt, windows: [window] },
    });
    const hubAccount = {
      id: "claude.json",
      driver: claude,
      email: "same@example.com",
      usageLimits: { checkedAt, windows: [window] },
    };
    const withOther = (other: ServerProvider) =>
      new Map([
        [
          EnvironmentId.make("env-a"),
          {
            ...laptop,
            serverConfig: {
              providers: [native, other],
              usageLimitSources: [{ ...source, accounts: [hubAccount] }],
            },
          },
        ],
      ]);
    const unrelated = provider({ instanceId: ProviderInstanceId.make("codex-2") });
    expect(collectLimitAccounts(withOther(unrelated)).map((account) => account.key)).toEqual([
      "env-a:codex",
    ]);
    const unreadable = provider({
      ...native,
      instanceId: ProviderInstanceId.make("team"),
      auth: { ...native.auth, workspaceId: "org-b" },
      usageLimits: { checkedAt, windows: [], unavailable: { reason: "probeFailed" } },
    });
    expect(collectLimitAccounts(withOther(unreadable)).map((account) => account.key)).toEqual([
      "env-a:codex",
      "env-a:hub:claude.json",
    ]);
  });

  it.each([
    [
      "one remote hub under environment-local ids",
      "http://hub:8317",
      "laptop-hub",
      "http://hub:8317",
      1,
    ],
    ["two remote hubs under one id", "http://hub:8317", "hub", "http://hub-8317", 2],
    [
      "two remote hubs under paths of one origin",
      "https://proxy.example/team-a",
      "hub-b",
      "https://proxy.example/team-b",
      2,
    ],
    [
      "a shared IPv6 tailnet hub",
      "http://[fd7a:115c:a1e0::1]:8317",
      "hub",
      "http://[fd7a:115c:a1e0::1]:8317",
      1,
    ],
    [
      "each machine's own localhost hub",
      "http://localhost:8317",
      "hub",
      "http://localhost:8317",
      2,
    ],
    ["each machine's own IPv6 loopback hub", "http://[::1]:8317", "hub", "http://[::1]:8317", 2],
    [
      "each machine's own localhost subdomain hub",
      "http://hub.localhost:8317",
      "hub",
      "http://hub.localhost:8317",
      2,
    ],
    [
      "each machine's own trailing-dot localhost subdomain hub",
      "http://hub.localhost.:8317",
      "hub",
      "http://hub.localhost.:8317",
      2,
    ],
    [
      "each machine's own mapped IPv4 loopback hub",
      "http://[::ffff:7f00:1]:8317",
      "hub",
      "http://[::ffff:7f00:1]:8317",
      2,
    ],
    ["each machine's own wildcard hub", "http://0.0.0.0:8317", "hub", "http://0.0.0.0:8317", 2],
    ["hubs that report no endpoint", undefined, "hub", undefined, 2],
  ] as const)(
    "keeps email-less hub identity across environments: %s",
    (_, firstEndpoint, secondId, secondEndpoint, count) => {
      const seat = {
        id: "claude-team-seat.json",
        driver: claude,
        usageLimits: { checkedAt, windows: [window] },
      };
      const hubAt = (id: string, endpoint: string | undefined) => ({
        ...source,
        id: UsageLimitSourceId.make(id),
        ...(endpoint ? { origin: new URL(endpoint).origin, endpoint } : {}),
        accounts: [seat],
      });
      const input = new Map([
        [
          EnvironmentId.make("env-a"),
          {
            ...laptop,
            serverConfig: { providers: [], usageLimitSources: [hubAt("hub", firstEndpoint)] },
          },
        ],
        [
          EnvironmentId.make("env-b"),
          {
            entry: { target: { label: "Desktop" } },
            serverConfig: { providers: [], usageLimitSources: [hubAt(secondId, secondEndpoint)] },
          },
        ],
      ]);
      const accounts = collectLimitAccounts(input);
      expect(accounts).toHaveLength(count);
      expect(accounts[0]?.displayName).toBe("claude-team-seat");
    },
  );

  it("keeps public keys apart for different logins in one hub file", () => {
    const hubAt = (id: string, email: string, usedPercent: number) => ({
      ...source,
      id: UsageLimitSourceId.make(id),
      origin: "https://hub.test",
      endpoint: "https://hub.test",
      accounts: [
        {
          id: "seat.json",
          driver: claude,
          email,
          usageLimits: { checkedAt, windows: [{ ...window, usedPercent }] },
        },
      ],
    });
    const input = new Map([
      [
        EnvironmentId.make("env-a"),
        {
          ...laptop,
          serverConfig: {
            providers: [],
            usageLimitSources: [hubAt("first", "old@example.com", 10)],
          },
        },
      ],
      [
        EnvironmentId.make("env-b"),
        {
          entry: { target: { label: "Desktop" } },
          serverConfig: {
            providers: [],
            usageLimitSources: [hubAt("second", "new@example.com", 80)],
          },
        },
      ],
    ]);
    const accounts = collectLimitAccounts(input);
    expect(accounts.map((account) => account.key)).toEqual([
      "env-a:first:seat.json",
      "env-b:second:seat.json",
    ]);
    const columns = collectLimitPools(accounts, Date.parse(checkedAt))[0]?.windows[0]?.columns;
    expect(columns?.map((column) => [column.account.email, column.window?.usedPercent])).toEqual([
      ["new@example.com", 80],
      ["old@example.com", 10],
    ]);
  });

  it("fills the gaps in one environment's hub history from another's", () => {
    const hub = (
      checkedAt: string,
      usedPercent: ReadonlyArray<number | null>,
      startsAt: string,
    ) => ({
      ...source,
      origin: "https://hub.test",
      endpoint: "https://hub.test",
      checkedAt,
      accounts: [
        {
          id: "claude-team-seat.json",
          driver: claude,
          usageLimits: {
            checkedAt,
            windows: [{ ...weekly, usedPercent: 30, history: { startsAt, usedPercent } }],
          },
        },
      ],
    });
    const input = new Map([
      [
        EnvironmentId.make("asleep"),
        {
          ...laptop,
          serverConfig: {
            providers: [],
            usageLimitSources: [
              hub("2026-09-03T12:00:00.000Z", [20, null, null, 26], "2026-09-03T08:00:00.000Z"),
            ],
          },
        },
      ],
      [
        EnvironmentId.make("always-on"),
        {
          entry: { target: { label: "Server" } },
          serverConfig: {
            providers: [],
            usageLimitSources: [hub(checkedAt, [10, 20, 22, 24, 25], "2026-09-03T07:00:00.000Z")],
          },
        },
      ],
    ]);
    const [account] = collectLimitAccounts(input);
    expect(account?.limits.windows[0]?.history).toEqual({
      startsAt: "2026-09-03T07:00:00.000Z",
      stepMins: 60,
      usedPercent: [10, 20, 22, 24, 26],
    });
  });

  it("labels a default-named instance merged with a hub account by e-mail, keeping a chosen name", () => {
    const native = provider({
      driver: claude,
      instanceId: ProviderInstanceId.make("claudeAgent"),
      displayName: "Claude",
      auth: { status: "authenticated", email: "a@example.com" },
      usageLimits: { checkedAt, windows: [window] },
    });
    const named = provider({
      driver: claude,
      instanceId: ProviderInstanceId.make("claude-work"),
      displayName: "Work",
      auth: { status: "authenticated", email: "b@example.com" },
      usageLimits: { checkedAt, windows: [window] },
    });
    const hubAccount = (email: string) => ({
      id: `claude-${email}.json`,
      driver: claude,
      email,
      usageLimits: { checkedAt, windows: [window] },
    });
    const input = new Map([
      [
        EnvironmentId.make("env-a"),
        {
          ...laptop,
          serverConfig: {
            providers: [native, named],
            usageLimitSources: [
              {
                ...source,
                accounts: [
                  hubAccount("a@example.com"),
                  hubAccount("b@example.com"),
                  hubAccount("c@example.com"),
                ],
              },
            ],
          },
        },
      ],
    ]);
    expect(
      collectLimitAccounts(input).map(({ displayName, email }) => ({ displayName, email })),
    ).toEqual([
      { displayName: null, email: "a@example.com" },
      { displayName: "Work", email: "b@example.com" },
      { displayName: null, email: "c@example.com" },
    ]);
  });

  it("pools Codex windows by kind, whichever slot reported them", () => {
    const codexAccount = (id: string, slots: readonly string[]) => ({
      id,
      driver: ProviderDriverKind.make("codex"),
      usageLimits: {
        checkedAt,
        windows: slots.map((slot) => ({ ...weekly, id: slot, usedPercent: 50 })),
      },
    });
    const pooled = (accounts: ReturnType<typeof codexAccount>[]) =>
      collectLimitPools(
        collectLimitAccounts(
          new Map([
            [
              EnvironmentId.make("env-a"),
              {
                ...laptop,
                serverConfig: { providers: [], usageLimitSources: [{ ...source, accounts }] },
              },
            ],
          ]),
        ),
        now,
      )[0]?.windows ?? [];
    for (const order of [
      [codexAccount("business", ["primary"]), codexAccount("plus", ["secondary"])],
      [codexAccount("plus", ["secondary"]), codexAccount("business", ["primary"])],
    ]) {
      const windows = pooled(order);
      expect(windows.map((window) => window.id)).toEqual(["weekly"]);
      expect(windows[0]?.members).toHaveLength(2);
    }
    expect(
      pooled([codexAccount("a", ["secondary"]), codexAccount("b", ["primary", "secondary"])]).map(
        (window) => window.id,
      ),
    ).toEqual(["weekly", "weekly:secondary"]);
  });

  it("weights pooled Codex quota and resets by each account's plan capacity", () => {
    const [pool] = collectLimitPools(
      collectLimitAccounts(
        new Map([
          [
            EnvironmentId.make("env-a"),
            {
              ...laptop,
              serverConfig: {
                providers: [],
                usageLimitSources: [
                  {
                    ...source,
                    accounts: [
                      ["pro", "ChatGPT Pro 200 Subscription", 100],
                      ["plus", "ChatGPT Plus Subscription", 0],
                    ].map(([id, plan, usedPercent]) => ({
                      id: String(id),
                      email: `${id}@example.com`,
                      driver: ProviderDriverKind.make("codex"),
                      plan: String(plan),
                      usageLimits: {
                        checkedAt,
                        windows: [{ ...weekly, id: "secondary", usedPercent: Number(usedPercent) }],
                      },
                    })),
                  },
                ],
              },
            },
          ],
        ]),
      ),
      now,
    );
    const [pooledWeekly] = pool?.windows ?? [];
    // Pro 20x holds 20 of the pool's 21 capacity parts.
    expect(pooledWeekly?.remainingPercent).toBe(5);
    expect(
      pooledWeekly?.resets.map(({ member, restoresPercent }) => [
        member.account.email,
        restoresPercent,
      ]),
    ).toContainEqual(["pro@example.com", 95]);
  });

  it("pools windows by id across accounts and orders resets by when they land", () => {
    const input = new Map([
      [
        EnvironmentId.make("env-a"),
        {
          ...laptop,
          serverConfig: {
            providers: [],
            usageLimitSources: [
              {
                ...source,
                accounts: [
                  {
                    id: "a",
                    driver: claude,
                    usageLimits: {
                      checkedAt,
                      windows: [
                        { ...window, usedPercent: 80, resetsAt: "2026-09-03T13:00:00.000Z" },
                        { ...weekly, usedPercent: 20 },
                      ],
                    },
                  },
                  {
                    id: "b",
                    driver: claude,
                    usageLimits: {
                      checkedAt,
                      windows: [{ ...window, usedPercent: 40 }],
                    },
                  },
                  {
                    id: "c",
                    driver: ProviderDriverKind.make("codex"),
                    usageLimits: { checkedAt, windows: [{ ...weekly, usedPercent: 50 }] },
                  },
                  {
                    id: "unsupported",
                    driver: claude,
                    usageLimits: {
                      checkedAt,
                      windows: [],
                      unavailable: { reason: "unsupported" as const },
                    },
                  },
                ],
              },
            ],
          },
        },
      ],
    ]);
    const pools = collectLimitPools(collectLimitAccounts(input), now);
    expect(pools.map((pool) => [pool.driver, pool.accounts.length])).toEqual([
      ["claudeAgent", 2],
      ["codex", 1],
    ]);
    const [session, week] = pools[0]!.windows;
    const untimed = collectLimitPools(
      collectLimitAccounts(input).map((account) =>
        account.key === "env-a:hub:b"
          ? {
              ...account,
              limits: {
                ...account.limits,
                windows: account.limits.windows.map((w) => ({ ...w, resetsAt: undefined })),
              },
            }
          : account,
      ),
      now,
    );
    expect(untimed[0]?.windows[0]?.pace).toBe("on");
    expect(session).toMatchObject({
      id: "five_hour",
      remainingPercent: 40,
      usedPercent: 60,
      pace: "under",
    });
    expect(
      session?.resets.map((reset) => [reset.member.account.key, reset.restoresPercent]),
    ).toEqual([
      ["env-a:hub:a", 40],
      ["env-a:hub:b", 20],
    ]);
    expect(week).toMatchObject({ id: "seven_day", remainingPercent: 80, members: [{}] });
    // A plan four times b's size holds four fifths of the pool, once every plan is known.
    const [weighted] = collectLimitPools(
      collectLimitAccounts(input).map((account) => ({
        ...account,
        capacity: account.key === "env-a:hub:a" ? 4 : 1,
      })),
      now,
    )[0]!.windows;
    expect(weighted).toMatchObject({ remainingPercent: 28, usedPercent: 72 });
    expect(weighted?.resets.map((reset) => reset.restoresPercent)).toEqual([64, 8]);
    // Codex reports `primary` for both its five-hour and (on Go) monthly window.
    const mixed = collectLimitPools(
      [
        ...collectLimitAccounts(input),
        {
          key: "go",
          driver: claude,
          displayName: "Go",
          email: undefined,
          plan: undefined,
          capacity: undefined,
          accentColor: undefined,
          image: undefined,
          environments: [],
          sourceLabel: null,
          redeem: null,
          routing: null,
          disabled: false,
          stale: false,
          limits: {
            checkedAt,
            windows: [
              {
                id: "five_hour",
                kind: "monthly",
                label: "Monthly",
                usedPercent: 82,
                windowDurationMins: 30 * 24 * 60,
                resetsAt: "2026-09-14T12:00:00.000Z",
              },
            ],
          },
        },
      ],
      now,
    );
    expect(mixed[0]?.windows.map((window) => [window.kind, window.members.length])).toEqual([
      ["session", 2],
      ["weekly", 1],
      ["monthly", 1],
    ]);
    expect(session?.members.map((member) => member.account.key)).toEqual([
      "env-a:hub:a",
      "env-a:hub:b",
    ]);
    expect(pools[0]?.accounts.map((account) => account.key)).toEqual([
      "env-a:hub:a",
      "env-a:hub:b",
    ]);

    // Changing reset order must preserve the rounded percentages for the same readings.
    for (const { readings, used, left } of [
      { readings: [94, 94.3, 97.9, 99.8], used: 97, left: 4 },
      { readings: [70, 87, 85.50000000000001, 1e-30, 1e-30], used: 49, left: 51 },
    ]) {
      const resetTimes = readings.map((_, index) => `2026-09-03T1${3 + index}:00:00.000Z`);
      for (const order of [resetTimes, [...resetTimes].reverse()]) {
        const [pooled] = collectLimitPools(
          readings.map((usedPercent, index) => ({
            key: `pooled-${index}`,
            driver: claude,
            displayName: `Pooled ${index}`,
            email: undefined,
            plan: undefined,
            capacity: undefined,
            accentColor: undefined,
            image: undefined,
            environments: [],
            sourceLabel: null,
            redeem: null,
            routing: null,
            disabled: false,
            stale: false,
            limits: { checkedAt, windows: [{ ...window, usedPercent, resetsAt: order[index] }] },
          })),
          now,
        );
        expect(pooled?.windows[0]).toMatchObject({ usedPercent: used, remainingPercent: left });
      }
    }
  });
});

describe("pooled account columns", () => {
  const weekly = {
    ...window,
    id: "seven_day",
    kind: "weekly",
    label: "Weekly",
    windowDurationMins: 7 * 24 * 60,
  } as const;
  const account = (key: string, windows: LimitAccount["limits"]["windows"]): LimitAccount => ({
    key,
    driver: ProviderDriverKind.make("claudeAgent"),
    displayName: key,
    email: undefined,
    plan: undefined,
    capacity: undefined,
    accentColor: undefined,
    image: undefined,
    environments: [],
    sourceLabel: "Hub",
    redeem: null,
    routing: null,
    disabled: false,
    stale: false,
    limits: { checkedAt: "2026-09-03T11:00:00.000Z", windows },
  });
  const keys = (pool: ReturnType<typeof collectLimitPools>[number]) =>
    pool.windows.map((row) =>
      row.columns.map((member) => (member.window ? member.account.key : null)),
    );

  it.each([
    {
      reports: [
        [14, 14],
        [14, 14],
      ],
      ids: ["autoPercentUsed"],
      remaining: [86],
      label: null,
    },
    {
      reports: [
        [14, 14],
        [80, 70],
      ],
      ids: ["totalPercentUsed", "autoPercentUsed"],
      remaining: [53, 58],
      label: "Cursor Models",
    },
    {
      reports: [[undefined, 14]],
      ids: ["autoPercentUsed"],
      remaining: [86],
      label: "Cursor Models",
    },
    { reports: [[14, undefined]], ids: ["totalPercentUsed"], remaining: [86], label: null },
  ])("preserves Cursor totals and scope for $reports", ({ reports, ids, remaining, label }) => {
    const accounts = reports.map(([total, auto], index) => ({
      ...account(String(index), [
        ...(total === undefined ? [] : [{ ...weekly, id: "totalPercentUsed", usedPercent: total }]),
        ...(auto === undefined ? [] : [{ ...weekly, id: "autoPercentUsed", usedPercent: auto }]),
      ]),
      driver: ProviderDriverKind.make("cursor"),
    }));
    const pool = collectLimitPools(accounts, now)[0]!;
    const visible = displayLimitWindows(pool);
    expect(visible.map((window) => window.id)).toEqual(ids);
    expect(visible.map((window) => window.remainingPercent)).toEqual(remaining);
    expect(cursorUsageWindowDetails(ids.at(-1)!, pool)?.label).toBe(label);
  });

  // regression: #20349 sessions stay visible while the weekly quota is exhausted
  it.each([
    ["claudeAgent", "13:00", 40, "14:00", 100],
    ["claudeAgent", undefined, 0, "14:00", 100],
    ["codex", "14:00", 100, "14:00", 100],
    ["claudeAgent", "15:00", 100, "15:00", 100],
    ["codex", "15:00", 40, "14:00", 60],
  ] as const)(
    "%s session resetting at %s with %i percent spent becomes usable at %s with %i percent restored",
    (driver, sessionReset, usedPercent, usableAt, restoresPercent) => {
      const at = (time: string) => `2026-09-03T${time}:00.000Z`;
      const a = {
        ...account("a", [
          {
            ...window,
            id: driver === "codex" ? "primary" : window.id,
            usedPercent,
            resetsAt: sessionReset === undefined ? undefined : at(sessionReset),
          },
          {
            ...weekly,
            id: driver === "codex" ? "secondary" : weekly.id,
            usedPercent: 100,
            resetsAt: at("14:00"),
          },
        ]),
        driver: ProviderDriverKind.make(driver),
      };
      const [session] = collectLimitPools([a], now)[0]!.windows;
      expect.soft(session?.remainingPercent).toBe(0);
      expect(session?.resets[0]).toMatchObject({
        at: Date.parse(at(usableAt)),
        restoresPercent,
      });
    },
  );

  it("excludes weekly-blocked sessions from the pool without changing snapshots or model allowances", () => {
    const blocked = account("blocked", [
      window,
      { ...weekly, usedPercent: 100 },
      { ...weekly, id: "seven_day_fable", usedPercent: 20 },
    ]);
    const accounts = [
      blocked,
      account("available", [
        { ...window, usedPercent: 20 },
        { ...weekly, usedPercent: 99 },
        { ...weekly, id: "seven_day_fable", usedPercent: 40 },
      ]),
      { ...blocked, key: "cursor", driver: ProviderDriverKind.make("cursor") },
    ];
    const snapshot = structuredClone(accounts);
    const [claude, cursor] = collectLimitPools(accounts, now);
    expect.soft(claude?.windows.map((row) => row.remainingPercent)).toEqual([40, 1, 70]);
    expect.soft(cursor?.windows.map((row) => row.remainingPercent)).toEqual([60, 0, 80]);
    expect(accounts).toEqual(snapshot);
  });

  it("keeps session columns across rows with opposite reset and usage orders", () => {
    const accounts = [
      account("a", [
        { ...weekly, usedPercent: 80, resetsAt: "2026-09-05T12:00:00.000Z" },
        { ...window, usedPercent: 10, resetsAt: "2026-09-03T15:00:00.000Z" },
      ]),
      account("b", [
        { ...weekly, usedPercent: 20, resetsAt: "2026-09-06T12:00:00.000Z" },
        { ...window, usedPercent: 90, resetsAt: "2026-09-03T13:00:00.000Z" },
      ]),
    ];
    const [pool] = collectLimitPools(accounts, now);
    expect(pool!.accounts.map((account) => account.key)).toEqual(["b", "a"]);
    expect(keys(pool!)).toEqual([
      ["b", "a"],
      ["b", "a"],
    ]);
    expect(pool!.windows[1]!.resets.map((reset) => reset.member.account.key)).toEqual(["a", "b"]);
    expect(pool!.windows[1]!.remainingPercent).toBe(50);
    expect(keys(collectLimitPools(accounts.toReversed(), now)[0]!)).toEqual(keys(pool!));
  });

  it.each([undefined, "invalid", "2026-09-03T11:30:00.000Z"])(
    "keeps blocked sessions empty without predicting a refill from a missing or stale clock (%s)",
    (resetsAt) => {
      const [pool] = collectLimitPools(
        [
          account("session-clock", [
            { ...window, resetsAt },
            { ...weekly, usedPercent: 100 },
          ]),
          account("weekly-clock", [window, { ...weekly, usedPercent: 100, resetsAt }]),
        ],
        now,
      );
      expect(pool!.windows[0]).toMatchObject({ remainingPercent: 0, pace: null, resets: [] });
      expect(pool!.windows[0]!.columns.map((column) => column.window?.resetsAt)).toEqual([
        undefined,
        undefined,
      ]);
    },
  );

  it("orders by usable session refill and clears suppression after a fresh weekly reading", () => {
    const blocked = account("blocked", [
      { ...window, resetsAt: "2026-09-03T13:00:00.000Z" },
      { ...weekly, usedPercent: 100, resetsAt: "2026-09-03T15:00:00.000Z" },
    ]);
    const available = account("available", [window]);
    const [before] = collectLimitPools([blocked, available], now);
    expect(before!.accounts.map((account) => account.key)).toEqual(["available", "blocked"]);
    expect(before!.windows[0]!.remainingPercent).toBe(30);
    const refreshed = {
      ...blocked,
      limits: {
        checkedAt: "2026-09-03T12:00:00.000Z",
        windows: [blocked.limits.windows[0]!, { ...weekly, usedPercent: 10 }],
      },
    };
    const [after] = collectLimitPools([refreshed, available], now);
    expect(after!.accounts.map((account) => account.key)).toEqual(["blocked", "available"]);
    expect(after!.windows[0]!.remainingPercent).toBe(60);
    expect(after!.windows[0]!.resets[0]).toMatchObject({
      at: Date.parse("2026-09-03T13:00:00.000Z"),
      restoresPercent: 20,
    });
  });

  it("preserves gaps without counting missing windows toward pooled quota", () => {
    const [pool] = collectLimitPools(
      [
        account("a", [window]),
        account("b", [
          { ...window, resetsAt: "2026-09-03T15:00:00.000Z" },
          { ...weekly, usedPercent: 80 },
        ]),
        account("c", [weekly]),
      ],
      now,
    );
    expect(keys(pool!)).toEqual([
      ["a", "b", null],
      [null, "b", "c"],
    ]);
    expect(pool!.windows[1]!.members.map((member) => member.account.key)).toEqual(["b", "c"]);
    expect(pool!.windows[1]!.remainingPercent).toBe(40);
    expect(pool!.windows[1]!.resets.map((reset) => reset.restoresPercent)).toEqual([40, 20]);
  });

  it("shows switched-off logins after the pool without counting them", () => {
    const [pool] = collectLimitPools(
      [
        { ...account("off", [{ ...window, usedPercent: 100 }]), disabled: true },
        account("on", [{ ...window, usedPercent: 20 }]),
      ],
      now,
    );
    expect(pool!.accounts.map((member) => member.key)).toEqual(["on", "off"]);
    expect(pool!.windows[0]!.remainingPercent).toBe(80);
    expect(pool!.windows[0]!.offMembers.map((member) => member.account.key)).toEqual(["off"]);
  });

  it("lists hub logins by routing priority, then by reset, ahead of logins no hub routes", () => {
    const routed = (key: string, resetsAt: string, priority: number): LimitAccount => ({
      ...account(key, [{ ...window, resetsAt }]),
      routing: {
        environmentId: EnvironmentId.make("env"),
        sourceId: UsageLimitSourceId.make("hub"),
        accountId: key,
        priority,
        byReset: false,
      },
    });
    const [pool] = collectLimitPools(
      [
        routed("later", "2026-09-03T15:00:00.000Z", 0),
        account("native", [{ ...window, resetsAt: "2026-09-03T12:30:00.000Z" }]),
        routed("sooner", "2026-09-03T13:00:00.000Z", 0),
        routed("preferred", "2026-09-03T16:00:00.000Z", 2),
      ],
      now,
    );
    expect(pool!.accounts.map((member) => member.key)).toEqual([
      "preferred",
      "sooner",
      "later",
      "native",
    ]);
  });

  it("falls back to weekly resets when no account reports a session", () => {
    const [pool] = collectLimitPools(
      [
        account("a", [{ ...weekly, resetsAt: "2026-09-06T12:00:00.000Z" }]),
        account("b", [{ ...weekly, resetsAt: "2026-09-05T12:00:00.000Z" }]),
      ],
      now,
    );
    expect(keys(pool!)).toEqual([["b", "a"]]);
  });
});

describe("reset credit choices", () => {
  it("offers each kind of banked reset on its own, for hub logins as for local instances", () => {
    const credits = {
      availableCount: 3,
      nextCreditId: "weekly-1",
      options: [
        {
          creditId: "weekly-1",
          label: "Weekly reset",
          description: "Refills your weekly limit.",
          availableCount: 2,
        },
        {
          creditId: "fable-1",
          label: "Fable reset",
          description: "Refills Fable.",
          availableCount: 1,
        },
      ],
    };
    const hub = {
      sourceId: UsageLimitSourceId.make("hub"),
      accountId: "a.json",
      creditId: "weekly-1",
    };
    for (const input of [hub, { instanceId: ProviderInstanceId.make("claude") }]) {
      expect(
        resetCreditChoices(credits, input, now).map((choice) => [choice.summary, choice.input]),
      ).toEqual([
        ["Weekly reset · 2 left", { ...input, creditId: "weekly-1" }],
        ["Fable reset · 1 left", { ...input, creditId: "fable-1" }],
      ]);
    }
  });
  it("places each banked reset on the window it is mainly for, soonest expiry first", () => {
    const weekly = { ...window, id: "seven_day", kind: "weekly", label: "Weekly" } as const;
    const fable = { ...weekly, id: "seven_day_fable", label: "Weekly · Fable" } as const;
    const hub = {
      sourceId: UsageLimitSourceId.make("hub"),
      accountId: "a.json",
      creditId: "next",
    };
    const account = (
      windows: LimitAccount["limits"]["windows"],
      resetCredits: NonNullable<LimitAccount["limits"]["resetCredits"]>,
    ): LimitAccount => ({
      key: "a",
      driver: ProviderDriverKind.make("claudeAgent"),
      displayName: "a",
      email: undefined,
      plan: undefined,
      capacity: undefined,
      accentColor: undefined,
      image: undefined,
      environments: [],
      sourceLabel: "Hub",
      redeem: { environmentId: EnvironmentId.make("env"), input: hub },
      routing: null,
      disabled: false,
      stale: false,
      limits: { checkedAt: "2026-09-03T11:00:00.000Z", windows, resetCredits },
    });
    const option = (creditId: string, refills: string[], expiries: string[]) => ({
      creditId,
      label: creditId,
      description: creditId,
      availableCount: expiries.length,
      expiries,
      refills,
    });
    const claude = account([window, weekly, fable], {
      availableCount: 3,
      options: [
        option("fable", ["seven_day_fable", "seven_day"], ["2026-09-10T00:00:00Z"]),
        option(
          "full",
          ["seven_day", "five_hour"],
          ["2026-09-05T00:00:00Z", "2026-09-04T00:00:00Z"],
        ),
      ],
    });
    expect(
      bankedResets(claude).map((reset) => [reset.windowId, reset.expiries, reset.input]),
    ).toEqual([
      ["seven_day_fable", [Date.parse("2026-09-10T00:00:00Z")], { ...hub, creditId: "fable" }],
      [
        "seven_day",
        [Date.parse("2026-09-04T00:00:00Z"), Date.parse("2026-09-05T00:00:00Z")],
        { ...hub, creditId: "full" },
      ],
    ]);
    // Without a window it names, a reset falls back to the weekly window.
    const codex = account([window, weekly], {
      availableCount: 2,
      nextExpiresAt: "2026-09-04T00:00:00Z",
    });
    expect(
      bankedResets(codex).map((reset) => [reset.windowId, reset.availableCount, reset.expiries]),
    ).toEqual([["seven_day", 2, [Date.parse("2026-09-04T00:00:00Z")]]]);
  });
});

describe("/usage-limits", () => {
  const limits = { checkedAt: "2026-09-03T11:00:00.000Z", windows: [window] };
  const selected = provider({
    usageLimits: limits,
    auth: { status: "authenticated", email: "same@example.com" },
  });
  const sources = [
    {
      id: UsageLimitSourceId.make("hub"),
      kind: "cliproxy" as const,
      label: "Accounts",
      origin: "http://hub:8317",
      checkedAt: limits.checkedAt,
      accounts: [
        {
          id: "duplicate",
          driver: selected.driver,
          email: "SAME@example.com",
          usageLimits: limits,
        },
        { id: "oss", driver: selected.driver, plan: "Codex OSS", usageLimits: limits },
        { id: "other-provider", driver: ProviderDriverKind.make("claude"), usageLimits: limits },
      ],
    },
  ];

  it("uses hub credit balances and redemption targets in the composer, including native duplicates", () => {
    const hubs = sources.map((source) => ({
      ...source,
      accounts: source.accounts.map((account) => ({
        ...account,
        usageLimits: {
          ...account.usageLimits,
          resetCredits: { availableCount: 2, nextCreditId: `${account.id}-credit` },
        },
      })),
    }));
    const report = collectProviderUsageLimits(selected.instanceId, [selected], hubs, now);
    expect(report?.accounts[0]?.limits.resetCredits?.availableCount).toBe(2);
    expect(report?.accounts[0]?.resetCreditInput).toEqual({
      sourceId: "hub",
      accountId: "duplicate",
      creditId: "duplicate-credit",
    });
    expect(report?.accounts.find((account) => account.id === "hub:oss")?.resetCreditInput).toEqual({
      sourceId: "hub",
      accountId: "oss",
      creditId: "oss-credit",
    });
  });

  it("gives a hub credit to no native row when its email is signed in to two workspaces", () => {
    const workspaces = ["ws-a", "ws-b"].map((workspaceId) =>
      provider({
        instanceId: ProviderInstanceId.make(workspaceId),
        usageLimits: limits,
        auth: { status: "authenticated", email: "same@example.com", workspaceId },
      }),
    );
    const hub = [
      {
        ...sources[0]!,
        accounts: [
          {
            id: "duplicate",
            driver: selected.driver,
            email: "same@example.com",
            usageLimits: { ...limits, resetCredits: { availableCount: 2, nextCreditId: "c" } },
          },
        ],
      },
    ];
    const report = collectProviderUsageLimits(workspaces[0]!.instanceId, workspaces, hub, now);
    expect(report?.accounts.map((account) => account.resetCreditInput)).toEqual([
      { instanceId: "ws-a" },
      { instanceId: "ws-b" },
      { sourceId: "hub", accountId: "duplicate", creditId: "c" },
    ]);
  });

  it("redeems a native duplicate through the hub even when the native snapshot is fresher", () => {
    const fresher = provider({
      usageLimits: {
        checkedAt: "2026-09-03T11:30:00.000Z",
        windows: [window],
        resetCredits: { availableCount: 3, nextCreditId: "native-credit" },
      },
      auth: { status: "authenticated", email: "same@example.com" },
    });
    const stale = [
      {
        id: UsageLimitSourceId.make("hub"),
        kind: "cliproxy" as const,
        label: "Accounts",
        checkedAt: limits.checkedAt,
        accounts: [
          {
            id: "duplicate",
            driver: fresher.driver,
            email: "SAME@example.com",
            usageLimits: {
              ...limits,
              resetCredits: { availableCount: 2, nextCreditId: "hub-credit" },
            },
          },
        ],
      },
    ];
    const report = collectProviderUsageLimits(fresher.instanceId, [fresher], stale, now);
    expect(report?.accounts[0]?.resetCreditInput).toEqual({
      sourceId: "hub",
      accountId: "duplicate",
      creditId: "hub-credit",
    });
    expect(report?.accounts[0]?.limits.resetCredits?.availableCount).toBe(3);
  });

  it("labels hub rows by account id without .json", () => {
    const hub = [
      {
        ...sources[0]!,
        label: "CLIProxyAPI",
        accounts: [
          {
            id: "claude-b@example.com.json",
            driver: selected.driver,
            email: "b@example.com",
            usageLimits: limits,
          },
          { id: "team-seat.json", driver: selected.driver, usageLimits: limits },
        ],
      },
    ];
    const report = collectProviderUsageLimits(selected.instanceId, [selected], hub, now);
    expect(
      report?.accounts.filter((account) => account.sourceLabel).map((account) => account.label),
    ).toEqual(["CLIProxyAPI · claude-b@example.com", "CLIProxyAPI · team-seat"]);
  });

  it("keeps unidentified custom instances separate, filtering by driver", () => {
    const report = collectProviderUsageLimits(
      selected.instanceId,
      [
        selected,
        provider({
          instanceId: ProviderInstanceId.make("codex-work"),
          displayName: "Work",
          usageLimits: { ...limits, resetCredits: { availableCount: 2 } },
        }),
        provider({
          driver: ProviderDriverKind.make("claude"),
          instanceId: ProviderInstanceId.make("claude"),
          usageLimits: limits,
        }),
      ],
      sources,
      now,
    );
    expect(report?.createdAt).toBe("2026-09-03T12:00:00.000Z");
    expect(report?.accounts.map((account) => account.id)).toEqual([
      "codex",
      "codex-work",
      "hub:oss",
    ]);
    expect(report?.accounts[0]).toMatchObject({
      instanceId: selected.instanceId,
      email: selected.auth.email,
    });
    expect(report?.accounts[1]).toMatchObject({
      displayName: "Work",
      limits: { resetCredits: { availableCount: 2 } },
    });
    expect(report?.accounts[2]).toMatchObject({
      label: "Accounts · oss",
      sourceLabel: "CLI Proxy",
      plan: "Codex OSS",
    });
    expect(report?.notices).toEqual([]);
  });

  it("shows a proxied instance the hub accounts its model routes to, of any driver", () => {
    const routed = [
      {
        ...sources[0]!,
        accounts: sources[0]!.accounts.map((account) =>
          account.id === "oss" ? { ...account, models: ["gpt-5.6-sol"] } : account,
        ),
      },
    ];
    const proxy = provider({
      instanceId: ProviderInstanceId.make("claudex"),
      driver: ProviderDriverKind.make("claudeAgent"),
      auth: { status: "authenticated", type: "customEndpoint", endpoint: "http://hub:8317" },
    });
    // regression: #30778 a local login the hub does not route to is not this thread's account
    const unrelated = provider({
      instanceId: ProviderInstanceId.make("codex-personal"),
      usageLimits: limits,
      auth: { status: "authenticated", email: "personal@example.com" },
    });
    const ids = (instance: ServerProvider, model: string | null) =>
      collectProviderUsageLimits(
        instance.instanceId,
        [selected, proxy, unrelated],
        routed,
        now,
        model,
      )?.accounts.map((account) => account.id);
    expect(ids(proxy, "gpt-5.6-sol[1m]")).toEqual(["codex", "hub:oss"]);
    // regression: #30778 another hub's model list does not decide this hub's routing
    const other = {
      ...routed[0]!,
      id: UsageLimitSourceId.make("other"),
      origin: "http://other:8317",
      accounts: [
        {
          id: "x",
          driver: ProviderDriverKind.make("grok"),
          models: ["gpt-5.6-sol"],
          usageLimits: limits,
        },
      ],
    };
    expect(
      collectProviderUsageLimits(
        proxy.instanceId,
        [selected, proxy],
        [other, ...routed],
        now,
        "gpt-5.6-sol",
      )?.accounts.map((account) => account.id),
    ).toEqual(["codex", "hub:oss"]);
    // regression: #30778 a custom endpoint other than the hub does not follow the hub's routing
    const elsewhere = { ...proxy, auth: { ...proxy.auth, endpoint: "http://other:8317" } };
    expect(
      collectProviderUsageLimits(
        proxy.instanceId,
        [selected, elsewhere],
        routed,
        now,
        "gpt-5.6-sol",
      ),
    ).toBeNull();
    expect(ids(selected, "gpt-5.6-sol")).toEqual(["codex", "codex-personal", "hub:oss"]);
  });

  it("keeps the freshest usable native duplicate and the freshest native credits in either order", () => {
    const failed = provider({
      auth: selected.auth,
      usageLimits: {
        ...limits,
        checkedAt: "2026-09-03T11:40:00.000Z",
        unavailable: { reason: "probeFailed" },
      },
    });
    const credited = provider({
      instanceId: ProviderInstanceId.make("codex-credit"),
      auth: selected.auth,
      usageLimits: {
        checkedAt: "2026-09-03T11:20:00.000Z",
        windows: [{ ...window, usedPercent: 50 }],
        resetCredits: { availableCount: 2 },
      },
    });
    const staleCredit = provider({
      ...credited,
      instanceId: ProviderInstanceId.make("codex-stale-credit"),
      usageLimits: { ...limits, resetCredits: { availableCount: 3 } },
    });
    const freshest = provider({
      instanceId: ProviderInstanceId.make("codex-fresh"),
      auth: selected.auth,
      usageLimits: {
        checkedAt: "2026-09-03T11:30:00.000Z",
        windows: [{ ...window, usedPercent: 55 }],
      },
    });
    const duplicates = [failed, staleCredit, credited, freshest];
    for (const providers of [duplicates, duplicates.toReversed()]) {
      const report = collectProviderUsageLimits(failed.instanceId, providers, sources, now);
      expect(report?.accounts.map((account) => account.id)).toEqual(["codex-fresh", "hub:oss"]);
      expect(report?.accounts[0]).toMatchObject({
        limits: {
          checkedAt: "2026-09-03T11:30:00.000Z",
          windows: [{ usedPercent: 55 }],
          resetCredits: { availableCount: 2 },
        },
        resetCreditInput: { instanceId: "codex-credit" },
      });
      expect(report?.accounts[0]?.limits.unavailable).toBeUndefined();
    }
  });

  it("merges native workspace duplicates only while the workspace evidence is unambiguous", () => {
    const known = provider({
      ...selected,
      instanceId: ProviderInstanceId.make("workspace-a"),
      auth: { ...selected.auth, workspaceId: "ws-a" },
    });
    const fresh = provider({
      ...known,
      instanceId: ProviderInstanceId.make("workspace-a-fresh"),
      usageLimits: { ...limits, checkedAt: "2026-09-03T11:30:00.000Z" },
    });
    const natives = [known, fresh, selected];
    expect(
      collectProviderUsageLimits(selected.instanceId, natives, [], now)?.accounts.map(
        (account) => account.id,
      ),
    ).toEqual(["workspace-a-fresh"]);

    const unreadable = provider({
      instanceId: ProviderInstanceId.make("workspace-b"),
      auth: { ...selected.auth, workspaceId: "ws-b" },
    });
    expect(
      collectProviderUsageLimits(
        selected.instanceId,
        [...natives, unreadable],
        [],
        now,
      )?.accounts.map((account) => account.id),
    ).toEqual(["workspace-a-fresh", "codex"]);
    expect(
      collectProviderUsageLimits(
        selected.instanceId,
        [...natives, { ...unreadable, usageLimits: limits }],
        [],
        now,
      )?.accounts.map((account) => account.id),
    ).toEqual(["workspace-a-fresh", "codex", "workspace-b"]);
  });

  it("supports a source-only provider and keeps duplicates when the native probe failed", () => {
    expect(
      collectProviderUsageLimits(selected.instanceId, [provider({})], sources, now)?.accounts.map(
        (account) => account.id,
      ),
    ).toEqual(["hub:duplicate", "hub:oss"]);
    const failed = provider({ usageLimits: { ...limits, unavailable: { reason: "probeFailed" } } });
    expect(
      collectProviderUsageLimits(selected.instanceId, [failed], sources, now)?.accounts.map(
        (account) => account.id,
      ),
    ).toEqual(["codex", "hub:duplicate", "hub:oss"]);
    expect(collectProviderUsageLimits(selected.instanceId, [provider({})], [], now)).toBeNull();
    expect(
      collectProviderUsageLimits(
        selected.instanceId,
        [provider({ enabled: false, usageLimits: limits })],
        [],
        now,
      ),
    ).toBeNull();
  });

  it("surfaces source errors only for sources that carry the selected driver", () => {
    const failing = { ...sources[0]!, error: "token expired" };
    expect(
      collectProviderUsageLimits(selected.instanceId, [selected], [failing], now)?.notices,
    ).toEqual(["Accounts: token expired"]);
    const claudeOnly = { ...failing, accounts: failing.accounts.slice(2) };
    expect(
      collectProviderUsageLimits(selected.instanceId, [selected], [claudeOnly], now)?.notices,
    ).toEqual([]);
    const unreadable = { ...failing, accounts: [] };
    expect(
      collectProviderUsageLimits(selected.instanceId, [selected], [unreadable], now)?.notices,
    ).toEqual(["Accounts: token expired"]);
    const sourceOnly = collectProviderUsageLimits(
      selected.instanceId,
      [provider({})],
      [unreadable],
      now,
    );
    expect(sourceOnly?.accounts).toEqual([]);
    expect(sourceOnly?.notices).toEqual(["Accounts: token expired"]);
  });

  it("advertises global and workspace commands only for providers present in Limits", () => {
    const withWorkspace = provider({
      workspaceSnapshots: [
        { cwd: "/tmp/project", checkedAt: limits.checkedAt, slashCommands: [], skills: [] },
      ],
    });
    const [supported] = withUsageLimitsCommands([withWorkspace], sources);
    expect(supported?.slashCommands.map((command) => command.name)).toEqual(["usage-limits"]);
    expect(
      supported?.workspaceSnapshots?.[0]?.slashCommands.map((command) => command.name),
    ).toEqual(["usage-limits"]);
    expect(withUsageLimitsCommands([withWorkspace], [])[0]?.slashCommands).toEqual([]);
    const ownCommand = provider({
      slashCommands: [{ name: "usage-limits", description: "Provider's own" }],
    });
    expect(withUsageLimitsCommands([ownCommand], [])[0]?.slashCommands).toEqual([
      { name: "usage-limits", description: "Provider's own" },
    ]);
    const unreadable = { ...sources[0]!, accounts: [], error: "token expired" };
    expect(
      withUsageLimitsCommands([withWorkspace], [unreadable])[0]?.slashCommands.map(
        (command) => command.name,
      ),
    ).toEqual(["usage-limits"]);
    expect(
      withUsageLimitsCommands([selected], [])[0]?.slashCommands.map((command) => command.name),
    ).toEqual(["usage-limits"]);
    const unrelated = provider({ driver: ProviderDriverKind.make("claudeAgent") });
    const disabled = provider({ ...unrelated, enabled: false, usageLimits: limits });
    const mixed = withUsageLimitsCommands([selected, withWorkspace, unrelated, disabled], []);
    expect(mixed.map((entry) => entry.slashCommands.map((command) => command.name))).toEqual([
      ["usage-limits"],
      ["usage-limits"],
      [],
      [],
    ]);
    expect(mixed[2]).toBe(unrelated);
    expect(mixed[3]).toBe(disabled);
  });
});

describe("sameUsageLimitCommandCoverage", () => {
  const codexAccount = {
    id: "a",
    driver: ProviderDriverKind.make("codex"),
    usageLimits: { checkedAt: "2026-09-03T11:00:00.000Z", windows: [] },
  };
  const base = {
    id: UsageLimitSourceId.make("hub"),
    kind: "cliproxy" as const,
    label: "Accounts",
    checkedAt: "2026-09-03T11:00:00.000Z",
  };
  it("ignores quota movement but not the drivers offered the command", () => {
    const withCodex = [{ ...base, accounts: [codexAccount] }];
    const withCodexLater = [
      {
        ...base,
        accounts: [
          {
            ...codexAccount,
            usageLimits: { ...codexAccount.usageLimits, checkedAt: "2026-09-03T12:00:00.000Z" },
          },
        ],
      },
    ];
    expect(sameUsageLimitCommandCoverage(withCodex, withCodexLater)).toBe(true);
    expect(sameUsageLimitCommandCoverage(withCodex, [{ ...base, accounts: [] }])).toBe(false);
  });
  it("treats a failed read as a change in coverage, in both directions", () => {
    const empty = [{ ...base, accounts: [] }];
    const failed = [{ ...base, accounts: [], error: "token expired" }];
    expect(sameUsageLimitCommandCoverage(empty, failed)).toBe(false);
    expect(sameUsageLimitCommandCoverage(failed, empty)).toBe(false);
    expect(
      sameUsageLimitCommandCoverage(failed, [{ ...base, accounts: [], error: "still down" }]),
    ).toBe(true);
  });
});

describe("external usage settings", () => {
  it("deduplicates destinations across accounts and environments without inventing quota pools", () => {
    const managed = provider({
      usageLimits: {
        checkedAt: "2026-09-03T11:00:00.000Z",
        windows: [],
        unavailable: { reason: "unsupported", message: "Track usage in ChatGPT." },
        externalUsage: { label: "ChatGPT usage", url: "https://chatgpt.com/#settings/Usage" },
      },
    });
    const presentations = new Map([
      [
        EnvironmentId.make("a"),
        {
          entry: { target: { label: "A" } },
          serverConfig: {
            providers: [managed, { ...managed, instanceId: ProviderInstanceId.make("personal") }],
          },
        },
      ],
      [
        EnvironmentId.make("b"),
        { entry: { target: { label: "B" } }, serverConfig: { providers: [managed] } },
      ],
    ]);
    expect(collectExternalUsageLinks(presentations)).toEqual([
      {
        ...managed.usageLimits!.externalUsage,
        message: "Track usage in ChatGPT.",
        accounts: [`${managed.instanceId} on A`, "personal on A", `${managed.instanceId} on B`],
      },
    ]);
    expect(collectLimitAccounts(presentations)).toEqual([]);
    expect(collectLimitNotices(presentations)).toEqual([]);
  });

  it("shows a notice once when environments with one label report the same failure", () => {
    const failing = provider({
      usageLimits: {
        checkedAt: "2026-09-03T11:00:00.000Z",
        windows: [],
        unavailable: { reason: "probeFailed" },
      },
    });
    const host = { entry: { target: { label: "Host" } }, serverConfig: { providers: [failing] } };
    const presentations = new Map([
      [EnvironmentId.make("a"), host],
      [EnvironmentId.make("b"), host],
      [EnvironmentId.make("c"), host],
    ]);
    expect(collectLimitNotices(presentations)).toEqual(["Host · codex: Could not read limits."]);
  });

  it("shows the reason an account's limits are unsupported, but not a bare unsupported", () => {
    const unsupported = (message?: string) =>
      provider({
        usageLimits: {
          checkedAt: "2026-09-03T11:00:00.000Z",
          windows: [],
          unavailable: { reason: "unsupported", ...(message ? { message } : {}) },
        },
      });
    const notices = (limited: ServerProvider) =>
      collectLimitNotices(
        new Map([
          [
            EnvironmentId.make("a"),
            { entry: { target: { label: "Host" } }, serverConfig: { providers: [limited] } },
          ],
        ]),
      );
    expect(notices(unsupported("Sign in with Google to see Antigravity limits."))).toEqual([
      "codex: Sign in with Google to see Antigravity limits.",
    ]);
    expect(notices(unsupported())).toEqual([]);
  });

  it("names a hub account whose read failed unless another environment read it", () => {
    const checkedAt = "2026-09-03T11:00:00.000Z";
    const account = {
      id: "claude-tg@example.com.json",
      driver: ProviderDriverKind.make("claudeAgent"),
      email: "tg@example.com",
    };
    const failed = {
      ...account,
      usageLimits: {
        checkedAt,
        windows: [],
        unavailable: {
          reason: "probeFailed" as const,
          message: "The provider refused the hub request (HTTP 429).",
        },
      },
    };
    const read = {
      ...account,
      usageLimits: { checkedAt, windows: [{ ...window, usedPercent: 10 }] },
    };
    const hub = (accounts: readonly UsageLimitSourceAccount[]) => ({
      providers: [],
      usageLimitSources: [
        {
          id: UsageLimitSourceId.make("hub"),
          kind: "cliproxy" as const,
          label: "hub",
          checkedAt,
          accounts,
        },
      ],
    });
    const desktop = { entry: { target: { label: "Desktop" } }, serverConfig: hub([failed]) };
    expect(collectLimitNotices(new Map([[EnvironmentId.make("a"), desktop]]))).toEqual([
      "hub · tg@example.com: The provider refused the hub request (HTTP 429).",
    ]);
    // A switched-off hub login does not raise a notice when its read fails.
    expect(
      collectLimitNotices(
        new Map([
          [
            EnvironmentId.make("a"),
            { ...desktop, serverConfig: hub([{ ...failed, disabled: true }]) },
          ],
        ]),
      ),
    ).toEqual([]);
    expect(
      collectLimitNotices(
        new Map([
          [EnvironmentId.make("a"), desktop],
          [
            EnvironmentId.make("b"),
            { entry: { target: { label: "WSL" } }, serverConfig: hub([read]) },
          ],
        ]),
      ),
    ).toEqual([]);
    // The row resolves an omitted workspace to the only one known, so the notice must too.
    expect(
      collectLimitNotices(
        new Map([
          [EnvironmentId.make("a"), desktop],
          [
            EnvironmentId.make("b"),
            {
              entry: { target: { label: "WSL" } },
              serverConfig: hub([{ ...read, workspaceId: "ws-1" }]),
            },
          ],
        ]),
      ),
    ).toEqual([]);
    // Without an email, same-named auth files on two environment-local hubs are different accounts.
    const { email: _failedEmail, ...anonymousFailed } = failed;
    const { email: _readEmail, ...anonymousRead } = read;
    expect(
      collectLimitNotices(
        new Map([
          [EnvironmentId.make("a"), { ...desktop, serverConfig: hub([anonymousFailed]) }],
          [
            EnvironmentId.make("b"),
            { entry: { target: { label: "WSL" } }, serverConfig: hub([anonymousRead]) },
          ],
        ]),
      ),
    ).toEqual([
      "Desktop · hub · claude-tg@example.com: The provider refused the hub request (HTTP 429).",
    ]);
  });
});

describe("ChatGPT sharing presentation", () => {
  it("requires verified sharing metadata rather than the Codex driver or login type", () => {
    const codex = provider({ auth: { status: "authenticated", type: "chatgpt" } });
    expect(usesChatGptSharing(codex)).toBe(false);
    expect(
      usesChatGptSharing({ ...codex, auth: { ...codex.auth, subscriptionSharing: true } }),
    ).toBe(true);
    expect(
      usesChatGptSharing({
        ...codex,
        auth: { status: "unauthenticated", subscriptionSharing: true },
      }),
    ).toBe(false);
  });
});
