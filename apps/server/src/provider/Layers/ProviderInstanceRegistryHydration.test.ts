import { describe, expect, it } from "@effect/vitest";
import {
  BUILT_IN_PROVIDER_DRIVER_KINDS,
  isBuiltInProviderDriverKind,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerSettings,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { BUILT_IN_DRIVERS } from "../builtInDrivers.ts";
import { deriveProviderInstanceConfigMap } from "./ProviderInstanceRegistryHydration.ts";

const decodeSettings = Schema.decodeUnknownSync(ServerSettings);

describe("Pi instance hydration", () => {
  it("bootstraps Pi without adding or mutating legacy provider settings", () => {
    const settings = decodeSettings({});
    expect(Object.hasOwn(settings.providers, "pi")).toBe(false);
    expect(deriveProviderInstanceConfigMap(settings)[ProviderInstanceId.make("pi")]).toEqual({
      driver: "pi",
      config: { binaryPath: "pi" },
    });
    expect(settings.providerInstances).toEqual({});
  });

  it("preserves explicit disabled settings and custom Pi instances", () => {
    const settings = decodeSettings({
      providerInstances: {
        pi: { driver: "pi", enabled: false, config: { binaryPath: "/custom/pi" } },
        pi_other: { driver: "pi", config: { binaryPath: "other-pi" } },
      },
    });
    const result = deriveProviderInstanceConfigMap(settings);
    expect(result[ProviderInstanceId.make("pi")]).toEqual(
      settings.providerInstances[ProviderInstanceId.make("pi")],
    );
    expect(result[ProviderInstanceId.make("pi_other")]?.driver).toBe(ProviderDriverKind.make("pi"));
  });

  it("declares every built-in driver kind as materializable", () => {
    // Guards such as `isModelSelectionProviderEnabled` answer "enabled" for a
    // driver kind with no settings record because this layer materializes one.
    // A driver added to BUILT_IN_DRIVERS without a matching declaration would
    // silently fall back to another provider, so pin the two lists together.
    const settings = decodeSettings({});
    const configMap = deriveProviderInstanceConfigMap(settings);
    expect([...BUILT_IN_PROVIDER_DRIVER_KINDS].sort()).toEqual(
      BUILT_IN_DRIVERS.map((driver) => driver.driverKind).sort(),
    );
    for (const driver of BUILT_IN_DRIVERS) {
      expect(isBuiltInProviderDriverKind(driver.driverKind)).toBe(true);
      expect(configMap[ProviderInstanceId.make(driver.driverKind)]).toBeDefined();
    }
  });
});
