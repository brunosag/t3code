import { describe, expect, it } from "vitest";

import { hasSoleProviderInstance, resolveModelVendor } from "./modelVendor.ts";

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
