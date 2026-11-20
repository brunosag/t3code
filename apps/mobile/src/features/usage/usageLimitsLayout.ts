import { useAtomValue } from "@effect/atom-react";
import { orderedProviders } from "@t3tools/client-runtime/usage-limit-controls";
import type { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";

import type { UsageLimitsLayout } from "../../persistence/mobile-preferences";
import { mobilePreferencesAtom, saveMobilePreferences } from "../../state/preferences";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { PROVIDER_ORDER } from "./usageProviders";

/** The Limits view's saved provider order and hidden providers, limits and account rows. */
export function useUsageLimitsLayout() {
  const preferences = useAtomValue(mobilePreferencesAtom);
  const save = useAtomCommand(saveMobilePreferences);
  const layout: UsageLimitsLayout = AsyncResult.isSuccess(preferences)
    ? (preferences.value.usageLimitsLayout ?? {})
    : {};
  return {
    providerOrder: orderedProviders(layout.providerOrder, PROVIDER_ORDER),
    hiddenProviders: new Set(layout.hiddenProviders),
    hiddenLimits: new Set(layout.hiddenLimits),
    hiddenAccountRows: new Set(layout.hiddenAccountRows),
    // A transform, so changes to different fields in quick succession all land.
    update: (patch: Partial<UsageLimitsLayout>) => {
      void save({
        transform: (current) => ({ usageLimitsLayout: { ...current.usageLimitsLayout, ...patch } }),
      });
    },
  };
}

/** Environments where this client may change each hub control, keyed like `environmentIdsKey`. */
export const hubPermissionsAtom = Atom.family((key: string) =>
  Atom.make((get) => {
    const ids = key === "" ? [] : (key.split("\n") as EnvironmentId[]);
    const allowed = (permission: (id: EnvironmentId) => Atom.Atom<boolean>) =>
      new Set(ids.filter((id) => get(permission(id))));
    return {
      route: allowed(serverEnvironment.setUsageLimitSourceAccountOrder.permissionAtom),
      disable: allowed(serverEnvironment.setUsageLimitSourceAccountDisabled.permissionAtom),
      rename: allowed(serverEnvironment.updateSettings.permissionAtom),
    };
  }).pipe(Atom.withLabel(`mobile:usage-hub-permissions:${key}`)),
);
