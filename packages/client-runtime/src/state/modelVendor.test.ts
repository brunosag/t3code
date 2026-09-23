import { describe, expect, it } from "vite-plus/test";

import {
  hasSoleProviderInstance,
  resolveModelVendor,
  resolveModelVendorGlyph,
} from "./modelVendor.ts";

describe("resolveModelVendor", () => {
  it("reads the model id rather than the gateway that serves it", () => {
    // Pi's `opencode-go` gateway fronts several vendors at once, so the
    // qualifier in the slug must not decide the glyph.
    expect(resolveModelVendor({ slug: "opencode-go/muse-spark-1.3-contributor" })).toBe("meta");
    expect(resolveModelVendor({ slug: "opencode-go/deepseek-v4-pro" })).toBe("deepseek");
    expect(resolveModelVendor({ slug: "openai-codex/gpt-6-astra" })).toBe("openai");
  });

  it("falls back to the display name when the slug is opaque", () => {
    expect(resolveModelVendor({ slug: "m-7f3a", name: "Claude Sonnet 4" })).toBe("anthropic");
  });

  it("matches families by prefix, not substring", () => {
    expect(resolveModelVendor({ slug: "qwen3.8-max" })).toBe("qwen");
    expect(resolveModelVendor({ slug: "some-gpt-clone" })).toBeUndefined();
  });

  it("returns undefined for vendors with no rule", () => {
    expect(resolveModelVendor({ slug: "opencode-go/glm-5.3" })).toBeUndefined();
    expect(resolveModelVendor(null)).toBeUndefined();
  });
});

describe("resolveModelVendorGlyph", () => {
  const claude = { slug: "claude-sonnet-4", name: "Claude Sonnet 4" };

  it("shows the vendor mark alone while Pi is the only active provider", () => {
    expect(
      resolveModelVendorGlyph({ model: claude, driverKind: "pi", isSoleProviderInstance: true }),
    ).toEqual({ vendor: "anthropic", overlayProvider: false });
  });

  it("overlays Pi on the vendor mark while several providers are active", () => {
    expect(
      resolveModelVendorGlyph({ model: claude, driverKind: "pi", isSoleProviderInstance: false }),
    ).toEqual({ vendor: "anthropic", overlayProvider: true });
  });

  it("leaves other providers their own mark while several are active", () => {
    expect(
      resolveModelVendorGlyph({
        model: claude,
        driverKind: "codex",
        isSoleProviderInstance: false,
      }),
    ).toEqual({ vendor: undefined, overlayProvider: false });
  });

  it("keeps the plain provider mark for a model with no vendor rule", () => {
    expect(
      resolveModelVendorGlyph({
        model: { slug: "m-7f3a" },
        driverKind: "pi",
        isSoleProviderInstance: false,
      }),
    ).toEqual({ vendor: undefined, overlayProvider: false });
  });
});

describe("hasSoleProviderInstance", () => {
  const usable = { enabled: true, isAvailable: true };

  it("counts only enabled, available instances", () => {
    expect(hasSoleProviderInstance([usable, { enabled: false, isAvailable: true }])).toBe(true);
    expect(hasSoleProviderInstance([usable, { enabled: true, isAvailable: false }])).toBe(true);
  });

  it("is false with zero or several usable instances", () => {
    expect(hasSoleProviderInstance([])).toBe(false);
    expect(hasSoleProviderInstance([usable, usable])).toBe(false);
  });
});
