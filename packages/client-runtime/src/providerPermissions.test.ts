import { describe, expect, it } from "vite-plus/test";
import { providerManagesRuntimePermissions } from "./providerPermissions.ts";

describe("provider-managed runtime permissions", () => {
  it("keeps T3's runtime-mode control for missing, older, and unmanaged snapshots", () => {
    expect(providerManagesRuntimePermissions(undefined)).toBe(false);
    expect(providerManagesRuntimePermissions({})).toBe(false);
    expect(providerManagesRuntimePermissions({ managesRuntimePermissions: false })).toBe(false);
  });
  it("drops T3's runtime-mode control when the runtime owns permission policy", () => {
    expect(providerManagesRuntimePermissions({ managesRuntimePermissions: true })).toBe(true);
  });
});
