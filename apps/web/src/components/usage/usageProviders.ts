import type { UsageProviderKind } from "@t3tools/contracts";

import { ProviderDriverKind } from "@t3tools/contracts";

type UsageProviderPresentation = {
  readonly label: string;
  readonly color: string;
  readonly driverKind: ProviderDriverKind;
};

export const PROVIDER_PRESENTATION = {
  codex: {
    label: "Codex",
    color: "var(--contrast-foreground)",
    driverKind: ProviderDriverKind.make("codex"),
  },
  claude: {
    label: "Claude Code",
    color: "#d97757",
    driverKind: ProviderDriverKind.make("claudeAgent"),
  },
  grok: {
    label: "Grok Build",
    color: "color-mix(in oklab, var(--contrast-foreground) 72%, var(--background))",
    driverKind: ProviderDriverKind.make("grok"),
  },
  cursor: { label: "Cursor", color: "#8b8b8b", driverKind: ProviderDriverKind.make("cursor") },
  opencode: {
    label: "OpenCode",
    color: "#5b9bbd",
    driverKind: ProviderDriverKind.make("opencode"),
  },
  antigravity: {
    label: "Antigravity",
    color: "#8c7bd1",
    driverKind: ProviderDriverKind.make("antigravity"),
  },
  pi: {
    label: "Pi",
    color: "#4d9f8a",
    driverKind: ProviderDriverKind.make("pi"),
  },
  muse: {
    label: "Muse Code",
    color: "#0866ff",
    driverKind: ProviderDriverKind.make("muse"),
  },
} satisfies Record<UsageProviderKind, UsageProviderPresentation>;

export const PROVIDER_ORDER = Object.keys(PROVIDER_PRESENTATION) as UsageProviderKind[];

/** Saved order first; providers added since it was saved keep their default place at the end. */
export function orderedProviders(
  saved: readonly UsageProviderKind[] | undefined,
): readonly UsageProviderKind[] {
  return saved ? [...new Set([...saved, ...PROVIDER_ORDER])] : PROVIDER_ORDER;
}

export function usageProviderForDriver(driver: ProviderDriverKind): UsageProviderKind | undefined {
  return PROVIDER_ORDER.find((provider) => PROVIDER_PRESENTATION[provider].driverKind === driver);
}

/** Swap with the neighbour in `shown`, so a move skips providers that are not on screen. */
export function moveProvider(
  order: readonly UsageProviderKind[],
  shown: readonly UsageProviderKind[],
  provider: UsageProviderKind,
  offset: -1 | 1,
): readonly UsageProviderKind[] {
  const index = shown.indexOf(provider);
  const neighbour = index === -1 ? undefined : shown[index + offset];
  if (neighbour === undefined) return order;
  return order.map((entry) =>
    entry === provider ? neighbour : entry === neighbour ? provider : entry,
  );
}

export function providersWithUsage(
  totals: readonly {
    readonly provider: UsageProviderKind;
    readonly costUsd: number;
    readonly totalTokens: number;
  }[],
): readonly UsageProviderKind[] {
  const active = new Set(
    totals
      .filter((entry) => entry.totalTokens > 0 || entry.costUsd > 0)
      .map((entry) => entry.provider),
  );
  return PROVIDER_ORDER.filter((provider) => active.has(provider));
}
