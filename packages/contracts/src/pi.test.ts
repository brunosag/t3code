import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER,
  PROVIDER_DISPLAY_NAMES,
} from "./model.ts";
import { ProviderDriverKind } from "./providerInstance.ts";
import {
  PiConnectionSettings,
  resolveProviderInstanceEnabled,
  ServerSettings,
} from "./settings.ts";

const piDriver = ProviderDriverKind.make("pi");
const decodePiConnectionSettings = Schema.decodeUnknownSync(PiConnectionSettings);
const decodeServerSettings = Schema.decodeUnknownSync(ServerSettings);

describe("Pi UI integration", () => {
  it("defaults the Pi binary path to `pi`", () => {
    expect(decodePiConnectionSettings({}).binaryPath).toBe("pi");
  });

  it("trims an explicit Pi binary path and falls back on empty", () => {
    expect(decodePiConnectionSettings({ binaryPath: "  /usr/local/bin/pi  " }).binaryPath).toBe(
      "/usr/local/bin/pi",
    );
    expect(decodePiConnectionSettings({ binaryPath: "   " }).binaryPath).toBe("pi");
  });

  it("keeps Pi connection settings to the binary path only", () => {
    expect(Object.keys(decodePiConnectionSettings({}))).toEqual(["binaryPath"]);
  });

  it("carries no legacy `providers.pi` blob", () => {
    expect("pi" in decodeServerSettings({}).providers).toBe(false);
  });

  it("labels Pi and defaults its chat and text-generation models to `default`", () => {
    expect(PROVIDER_DISPLAY_NAMES[piDriver]).toBe("Pi");
    expect(DEFAULT_MODEL_BY_PROVIDER[piDriver]).toBe("default");
    expect(DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER[piDriver]).toBe("default");
  });

  it("resolves Pi enabled state generically from the instance envelope", () => {
    expect(resolveProviderInstanceEnabled({ driver: piDriver, config: {} })).toBe(true);
    expect(
      resolveProviderInstanceEnabled({ driver: piDriver, enabled: false, config: {} }),
    ).toBe(false);
  });
});
