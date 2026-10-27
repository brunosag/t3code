import { describe, expect, it } from "vite-plus/test";

import { moveProvider, orderedProviders, PROVIDER_ORDER } from "./usageProviders";

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
