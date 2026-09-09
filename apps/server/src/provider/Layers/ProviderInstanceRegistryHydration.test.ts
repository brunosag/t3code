import { describe, expect, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId, ServerSettings } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
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
});
