import { ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { ClaudeAI, PiIcon } from "../Icons";
import { resolveModelVendorIcon } from "./providerIconUtils";

const pi = ProviderDriverKind.make("pi");
const codex = ProviderDriverKind.make("codex");
const claude = { slug: "claude-sonnet-4", name: "Claude Sonnet 4" };

describe("resolveModelVendorIcon", () => {
  it("shows the vendor mark alone while Pi is the only active provider", () => {
    const glyph = resolveModelVendorIcon(claude, pi, true);
    expect(glyph?.icon).toBe(ClaudeAI);
    expect(glyph?.overlayIcon).toBeUndefined();
  });

  it("overlays the Pi mark on the vendor mark while several providers are active", () => {
    const glyph = resolveModelVendorIcon(claude, pi, false);
    expect(glyph?.icon).toBe(ClaudeAI);
    expect(glyph?.overlayIcon).toBe(PiIcon);
  });

  it("keeps other providers on the plain provider glyph while several are active", () => {
    expect(resolveModelVendorIcon(claude, codex, false)).toBeUndefined();
  });

  it("keeps the plain Pi glyph for a model with no vendor rule", () => {
    expect(resolveModelVendorIcon({ slug: "m-7f3a" }, pi, false)).toBeUndefined();
  });
});
