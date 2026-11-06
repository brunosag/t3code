import { describe, expect, it } from "vite-plus/test";

import {
  moveProvider,
  orderedProviders,
  PROVIDER_ORDER,
  rankProvidersByMetric,
} from "./usageProviders";

describe("usage provider order", () => {
  it("keeps providers missing from a saved order at the end", () => {
    const order = orderedProviders(["antigravity", "claude"]);
    expect(order.slice(0, 2)).toEqual(["antigravity", "claude"]);
    expect(order.toSorted()).toEqual(PROVIDER_ORDER.toSorted());
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

describe("rankProvidersByMetric", () => {
  it("ranks by the selected metric, highest first", () => {
    const totals = [
      { provider: "codex" as const, totalTokens: 100, costUsd: 20 },
      { provider: "claude" as const, totalTokens: 200, costUsd: 10 },
    ];
    const providers = ["codex", "claude"] as const;

    expect(rankProvidersByMetric(providers, totals, "tokens")).toEqual(["claude", "codex"]);
    expect(rankProvidersByMetric(providers, totals, "cost")).toEqual(["codex", "claude"]);
  });

  it("keeps ties in input order without reordering the shared provider list", () => {
    const totals = [
      { provider: "codex" as const, totalTokens: 10, costUsd: 1 },
      { provider: "claude" as const, totalTokens: 10, costUsd: 1 },
      { provider: "grok" as const, totalTokens: 20, costUsd: 2 },
    ];
    const providers = ["claude", "codex", "grok"] as const;

    expect(rankProvidersByMetric(providers, totals, "tokens")).toEqual(["grok", "claude", "codex"]);
    expect(providers).toEqual(["claude", "codex", "grok"]);
  });
});
