import type {
  ProviderInstanceConfig,
  ProviderInstanceId,
  ProviderInstanceMutation,
  ServerSettings,
  ServerSettingsPatch,
  UsageLimitSourceConfig,
} from "@t3tools/contracts";
import * as Equal from "effect/Equal";

// Paths, setup and credentials differ per machine, and secrets reach clients redacted.
const MACHINE_CONFIG_KEYS = new Set(["setupMode", "serverUrl", "serverPassword", "apiKey"]);
// Registry agents install a binary on each machine, and removing one uninstalls it there.
const MACHINE_DRIVERS = new Set<string>(["acpRegistry"]);

const isMachineConfigKey = (key: string) => key.endsWith("Path") || MACHINE_CONFIG_KEYS.has(key);

function configEntries(config: unknown, machine: boolean) {
  if (config === null || typeof config !== "object" || Array.isArray(config)) return [];
  return Object.entries(config).filter(([key]) => isMachineConfigKey(key) === machine);
}

/** The target's instance carrying the source's shared fields; machine fields stay the target's. */
function shareProviderInstance(
  source: ProviderInstanceConfig,
  target: ProviderInstanceConfig,
): ProviderInstanceConfig {
  const config = Object.fromEntries([
    ...configEntries(source.config, false),
    ...configEntries(target.config, true),
  ]);
  return {
    driver: target.driver,
    ...(source.displayName !== undefined ? { displayName: source.displayName } : {}),
    ...(source.accentColor !== undefined ? { accentColor: source.accentColor } : {}),
    ...(source.enabled !== undefined ? { enabled: source.enabled } : {}),
    ...(target.environment !== undefined ? { environment: target.environment } : {}),
    ...(Object.keys(config).length > 0 ? { config } : {}),
  };
}

/** The same change for another machine, or null when that machine keeps its own. */
export function shareProviderInstanceMutation(
  mutation: ProviderInstanceMutation,
  source: ServerSettings,
  target: ServerSettings,
): ProviderInstanceMutation | null {
  const { instanceId } = mutation;
  const sourceInstance = source.providerInstances[instanceId];
  const targetInstance = target.providerInstances[instanceId];
  const driver =
    mutation.operation === "remove"
      ? (sourceInstance ?? targetInstance)?.driver
      : mutation.instance.driver;
  if (driver === undefined || MACHINE_DRIVERS.has(driver)) return null;
  if (targetInstance !== undefined && targetInstance.driver !== driver) return null;
  // Only instances both machines configured are shared; one machine's provider stays its own.
  if (mutation.operation === "create") return targetInstance === undefined ? mutation : null;
  if (targetInstance === undefined) return null;
  switch (mutation.operation) {
    case "upsert":
      return {
        operation: "upsert",
        instanceId,
        instance: shareProviderInstance(mutation.instance, targetInstance),
      };
    case "remove":
      // A driver's default slot is reset rather than removed, so its machine fields stay.
      return String(instanceId) === String(driver)
        ? {
            operation: "upsert",
            instanceId,
            instance: shareProviderInstance({ driver }, targetInstance),
          }
        : mutation;
  }
}

function shareUsageLimitSource(
  source: UsageLimitSourceConfig,
  target: UsageLimitSourceConfig,
): UsageLimitSourceConfig {
  const { label: _label, accounts: _accounts, ...machine } = target;
  return {
    ...machine,
    ...(source.label !== undefined ? { label: source.label } : {}),
    enabled: source.enabled,
    ...(source.accounts !== undefined ? { accounts: source.accounts } : {}),
  };
}

/**
 * The provider and hub part of a settings patch, rewritten for another machine. A hub's address
 * and key stay the target's own; a hub new on the source is copied whole.
 */
export function shareProviderSettingsPatch(
  patch: ServerSettingsPatch,
  source: ServerSettings,
  target: ServerSettings,
): ServerSettingsPatch {
  const shared: { -readonly [K in keyof ServerSettingsPatch]: ServerSettingsPatch[K] } = {};
  if (patch.setModelFavorites) shared.setModelFavorites = patch.setModelFavorites;
  if (patch.setModelsHidden) shared.setModelsHidden = patch.setModelsHidden;
  if (patch.setProviderModelOrder) shared.setProviderModelOrder = patch.setProviderModelOrder;
  if (patch.usageLimitSources) {
    const sources: Record<string, UsageLimitSourceConfig | null> = {};
    for (const [id, value] of Object.entries(patch.usageLimitSources)) {
      const targetSource = target.usageLimitSources[id as keyof typeof target.usageLimitSources];
      if (value === null) {
        if (targetSource !== undefined) sources[id] = null;
      } else if (targetSource !== undefined) {
        sources[id] = shareUsageLimitSource(value, targetSource);
      } else if (!Object.hasOwn(source.usageLimitSources, id)) {
        sources[id] = value;
      }
    }
    if (Object.keys(sources).length > 0) {
      shared.usageLimitSources = sources as NonNullable<ServerSettingsPatch["usageLimitSources"]>;
    }
  }
  return shared;
}

export interface ProviderSettingsSync {
  readonly mutations: readonly ProviderInstanceMutation[];
  readonly patch: ServerSettingsPatch;
}

/**
 * What the target needs to match the source's shared provider settings. Instances and hubs that
 * only one machine has are left alone, as are model preferences for instances the source lacks.
 */
export function providerSettingsSync(
  source: ServerSettings,
  target: ServerSettings,
): ProviderSettingsSync {
  const mutations: ProviderInstanceMutation[] = [];
  for (const [id, sourceInstance] of Object.entries(source.providerInstances)) {
    const instanceId = id as ProviderInstanceId;
    const targetInstance = target.providerInstances[instanceId];
    if (targetInstance === undefined || targetInstance.driver !== sourceInstance.driver) continue;
    if (MACHINE_DRIVERS.has(sourceInstance.driver)) continue;
    const instance = shareProviderInstance(sourceInstance, targetInstance);
    if (!Equal.equals(instance, shareProviderInstance(targetInstance, targetInstance))) {
      mutations.push({ operation: "upsert", instanceId, instance });
    }
  }

  const patch: { -readonly [K in keyof ServerSettingsPatch]: ServerSettingsPatch[K] } = {};
  const sources: Record<string, UsageLimitSourceConfig> = {};
  for (const [id, sourceHub] of Object.entries(source.usageLimitSources)) {
    const targetHub = target.usageLimitSources[id as keyof typeof target.usageLimitSources];
    if (targetHub === undefined) continue;
    const next = shareUsageLimitSource(sourceHub, targetHub);
    if (!Equal.equals(next, targetHub)) sources[id] = next;
  }
  if (Object.keys(sources).length > 0) {
    patch.usageLimitSources = sources as NonNullable<ServerSettingsPatch["usageLimitSources"]>;
  }

  if (source.favorites !== null && target.favorites !== null) {
    const sourceProviders = new Set<string>([
      ...Object.keys(source.providerInstances),
      ...source.favorites.map((favorite) => favorite.provider),
    ]);
    const favorites = [
      ...source.favorites,
      ...target.favorites.filter((favorite) => !sourceProviders.has(favorite.provider)),
    ];
    if (!Equal.equals(favorites, target.favorites)) patch.favorites = favorites;
  }
  if (source.providerModelPreferences !== null && target.providerModelPreferences !== null) {
    const preferences = { ...target.providerModelPreferences, ...source.providerModelPreferences };
    if (!Equal.equals(preferences, target.providerModelPreferences)) {
      patch.providerModelPreferences = preferences;
    }
  }
  return { mutations, patch };
}

export const providerSettingsInSync = ({ mutations, patch }: ProviderSettingsSync) =>
  mutations.length === 0 && Object.keys(patch).length === 0;
