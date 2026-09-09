import { ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { getProviderManagedPermissions } from "./providerPermissions.ts";

describe("provider-managed permission presentation", () => {
  it("keeps T3 controls for missing, older, and explicitly unmanaged snapshots", () => {
    expect(getProviderManagedPermissions(undefined)).toBeUndefined();
    expect(
      getProviderManagedPermissions({ driver: ProviderDriverKind.make("pi") }),
    ).toBeUndefined();
    expect(
      getProviderManagedPermissions({
        driver: ProviderDriverKind.make("custom"),
        managesRuntimePermissions: false,
      }),
    ).toBeUndefined();
  });
  it("uses the capability and display name, not the driver identity", () => {
    expect(
      getProviderManagedPermissions({
        driver: ProviderDriverKind.make("pi"),
        displayName: "Pi",
        managesRuntimePermissions: true,
      }),
    ).toEqual({
      label: "Pi managed",
      description: "Permissions and tool behavior come from your Pi runtime.",
    });
    expect(
      getProviderManagedPermissions({
        driver: ProviderDriverKind.make("other"),
        displayName: "External",
        managesRuntimePermissions: true,
      }),
    ).toEqual({
      label: "External managed",
      description: "Permissions and tool behavior come from your External runtime.",
    });
  });
});
