import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderVersionAdvisory,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { nextAutoUpdate } from "./ProviderAutoUpdate.ts";

const behind: ServerProviderVersionAdvisory = {
  status: "behind_latest",
  currentVersion: "1.0.0",
  latestVersion: "1.1.0",
  updateCommand: "npm i -g provider",
  canUpdate: true,
  checkedAt: null,
  message: null,
};

const provider = (
  instance: string,
  driver: string,
  overrides: Partial<ServerProvider> = {},
): ServerProvider =>
  ({
    instanceId: ProviderInstanceId.make(instance),
    driver: ProviderDriverKind.make(driver),
    enabled: true,
    installed: true,
    versionAdvisory: behind,
    ...overrides,
  }) as ServerProvider;

const pick = (
  providers: ReadonlyArray<ServerProvider>,
  active: ReadonlyArray<string> = [],
  attempted: ReadonlyArray<[string, string]> = [],
) =>
  nextAutoUpdate({
    providers,
    activeInstanceIds: new Set(active.map((id) => ProviderInstanceId.make(id))),
    attempted: new Map(attempted.map(([id, version]) => [ProviderInstanceId.make(id), version])),
  })?.instanceId ?? null;

describe("nextAutoUpdate", () => {
  it("updates a provider behind its latest release while nothing uses it", () => {
    expect(pick([provider("codex", "codex")])).toBe("codex");
  });

  it("waits while a thread on the provider, or on another instance of its driver, works", () => {
    const providers = [
      provider("claude", "claudeAgent"),
      provider("claude-work", "claudeAgent", { versionAdvisory: { ...behind, status: "current" } }),
      provider("codex", "codex"),
    ];
    expect(pick(providers, ["claude"])).toBe("codex");
    expect(pick(providers, ["claude-work"])).toBe("codex");
    expect(pick(providers, ["claude", "codex"])).toBe(null);
  });

  it.each([
    ["current", { versionAdvisory: { ...behind, status: "current" as const } }],
    ["not updatable", { versionAdvisory: { ...behind, canUpdate: false } }],
    ["without a latest version", { versionAdvisory: { ...behind, latestVersion: null } }],
    ["disabled", { enabled: false }],
    ["not installed", { installed: false }],
    [
      "already updating",
      {
        updateState: {
          status: "running" as const,
          startedAt: null,
          finishedAt: null,
          message: null,
          output: null,
        },
      },
    ],
  ])("skips a provider that is %s", (_, overrides) => {
    expect(pick([provider("codex", "codex", overrides as Partial<ServerProvider>)])).toBe(null);
  });

  it("tries each release once, and again when a newer one appears", () => {
    const providers = [provider("codex", "codex")];
    expect(pick(providers, [], [["codex", "1.1.0"]])).toBe(null);
    expect(pick(providers, [], [["codex", "1.0.5"]])).toBe("codex");
  });
});
