import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerSettings,
  UsageLimitSourceId,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  providerSettingsInSync,
  providerSettingsSync,
  shareProviderInstanceMutation,
  shareProviderSettingsPatch,
} from "./sharedProviderSettings.ts";

const claude = ProviderDriverKind.make("claudeAgent");
const pool = ProviderInstanceId.make("claude-pool");
const hub = UsageLimitSourceId.make("cliproxy-vps");

const machine = (url: string, settings: Partial<ServerSettings> = {}): ServerSettings => ({
  ...DEFAULT_SERVER_SETTINGS,
  providerInstances: {
    [pool]: {
      driver: claude,
      displayName: "Claude Pool",
      enabled: true,
      environment: [{ name: "ANTHROPIC_BASE_URL", value: url, sensitive: false }],
      config: {
        binaryPath: "/bin/claude",
        homePath: "~/.claude_pool",
        autoCompactWindow: "300000",
      },
    },
  },
  usageLimitSources: {
    [hub]: { kind: "cliproxy", label: "Pool", url, managementKey: "••••••", enabled: true },
  },
  favorites: [],
  providerModelPreferences: {},
  ...settings,
});

const laptop = machine("https://vps.ts.net:8318");
const vps = machine("http://127.0.0.1:8317");

describe("shareProviderInstanceMutation", () => {
  it("copies shared fields onto the target's paths and environment", () => {
    const mutation = shareProviderInstanceMutation(
      {
        operation: "upsert",
        instanceId: pool,
        instance: {
          ...laptop.providerInstances[pool]!,
          displayName: "Pool",
          config: { binaryPath: "/elsewhere/claude", autoCompactWindow: "350000" },
        },
      },
      laptop,
      vps,
    );
    expect(mutation).toEqual({
      operation: "upsert",
      instanceId: pool,
      instance: {
        ...vps.providerInstances[pool],
        displayName: "Pool",
        config: {
          binaryPath: "/bin/claude",
          homePath: "~/.claude_pool",
          autoCompactWindow: "350000",
        },
      },
    });
  });

  it("leaves instances, registry agents and removals to the machines that have them", () => {
    const pi = ProviderInstanceId.make("pi");
    const onlyVps = machine("x", {
      providerInstances: {
        ...vps.providerInstances,
        [pi]: { driver: ProviderDriverKind.make("pi") },
      },
    });
    const upsertPi = {
      operation: "upsert",
      instanceId: pi,
      instance: { driver: ProviderDriverKind.make("pi"), enabled: false },
    } as const;
    expect(shareProviderInstanceMutation(upsertPi, onlyVps, laptop)).toBeNull();
    expect(
      shareProviderInstanceMutation({ operation: "remove", instanceId: pi }, onlyVps, laptop),
    ).toBeNull();

    const agent = ProviderInstanceId.make("agent");
    const create = {
      operation: "create",
      instanceId: agent,
      instance: { driver: ProviderDriverKind.make("acpRegistry") },
    } as const;
    expect(shareProviderInstanceMutation(create, laptop, vps)).toBeNull();
    expect(
      shareProviderInstanceMutation({ ...create, instance: { driver: claude } }, laptop, vps),
    ).toEqual({ ...create, instance: { driver: claude } });

    expect(
      shareProviderInstanceMutation({ operation: "remove", instanceId: pool }, laptop, vps),
    ).toEqual({ operation: "remove", instanceId: pool });
    // Resetting a default slot elsewhere resets its shared fields only.
    const claudeSlot = ProviderInstanceId.make("claudeAgent");
    const withSlot = machine("x", {
      providerInstances: {
        [claudeSlot]: {
          driver: claude,
          displayName: "Claude",
          config: { binaryPath: "claude", autoCompactWindow: "350000" },
        },
      },
    });
    expect(
      shareProviderInstanceMutation(
        { operation: "remove", instanceId: claudeSlot },
        withSlot,
        withSlot,
      ),
    ).toEqual({
      operation: "upsert",
      instanceId: claudeSlot,
      instance: { driver: claude, config: { binaryPath: "claude" } },
    });
  });
});

describe("shareProviderSettingsPatch", () => {
  it("shares hub names and accounts, keeps each machine's address, and copies new hubs", () => {
    const accounts = { "claude-a.json": { name: "Team" } };
    const added = UsageLimitSourceId.make("cliproxy-new");
    const newHub = {
      kind: "cliproxy",
      url: "https://new",
      managementKey: "key",
      enabled: true,
    } as const;
    expect(
      shareProviderSettingsPatch(
        {
          usageLimitSources: {
            [hub]: { ...laptop.usageLimitSources[hub]!, label: "Claude Pool", accounts },
            [added]: newHub,
          },
          setModelsHidden: [{ provider: pool, model: "claude-haiku-4-5", hidden: true }],
          sidebarAutoSettleOnMerge: true,
        },
        laptop,
        vps,
      ),
    ).toEqual({
      usageLimitSources: {
        [hub]: { ...vps.usageLimitSources[hub], label: "Claude Pool", accounts },
        [added]: newHub,
      },
      setModelsHidden: [{ provider: pool, model: "claude-haiku-4-5", hidden: true }],
    });
  });
});

describe("providerSettingsSync", () => {
  it("is in sync when only machine fields differ", () => {
    expect(providerSettingsInSync(providerSettingsSync(laptop, vps))).toBe(true);
  });

  it("brings shared fields across and keeps the target's own favorites", () => {
    const pi = ProviderInstanceId.make("pi");
    const source = machine("a", { favorites: [{ provider: pool, model: "claude-opus-5-5" }] });
    const target = machine("b", {
      favorites: [
        { provider: pi, model: "pi-model" },
        { provider: pool, model: "claude-sonnet-5-5" },
      ],
      usageLimitSources: { [hub]: { ...vps.usageLimitSources[hub]!, label: "Claude Pool" } },
    });
    expect(providerSettingsSync(source, target)).toEqual({
      mutations: [],
      patch: {
        usageLimitSources: { [hub]: { ...target.usageLimitSources[hub], label: "Pool" } },
        favorites: [
          { provider: pool, model: "claude-opus-5-5" },
          { provider: pi, model: "pi-model" },
        ],
      },
    });
  });
});
