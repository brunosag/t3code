// Installs a provider's newer release once no active thread runs on that provider, so updates land
// between turns instead of waiting for someone to press Update.
import type { ProviderInstanceId, ServerProvider } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { watchAgentWork } from "../background/SleepInhibitor.ts";
import { forkParked } from "../serverActivation.ts";
import * as ProviderMaintenanceRunner from "./providerMaintenanceRunner.ts";
import * as ProviderRegistry from "./ProviderRegistry.ts";

/**
 * The next provider to update: one behind its latest release, updatable, not already updating,
 * not yet tried at that release, and with no active thread on any instance of its driver (they
 * can share the installation an update replaces).
 */
export function nextAutoUpdate(input: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly activeInstanceIds: ReadonlySet<ProviderInstanceId>;
  readonly attempted: ReadonlyMap<ProviderInstanceId, string>;
}): ServerProvider | undefined {
  const busyDrivers = new Set(
    input.providers
      .filter((provider) => input.activeInstanceIds.has(provider.instanceId))
      .map((provider) => provider.driver),
  );
  return input.providers.find((provider) => {
    const advisory = provider.versionAdvisory;
    const updateStatus = provider.updateState?.status;
    return (
      provider.enabled &&
      provider.installed &&
      advisory?.status === "behind_latest" &&
      advisory.canUpdate &&
      advisory.latestVersion !== null &&
      updateStatus !== "queued" &&
      updateStatus !== "running" &&
      input.attempted.get(provider.instanceId) !== advisory.latestVersion &&
      !busyDrivers.has(provider.driver)
    );
  });
}

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const registry = yield* ProviderRegistry.ProviderRegistry;
    const runner = yield* ProviderMaintenanceRunner.ProviderMaintenanceRunner;
    // Unknown until the agent-work watcher reads the threads.
    const activeInstanceIds = yield* Ref.make<ReadonlySet<ProviderInstanceId> | null>(null);
    const wake = yield* Queue.sliding<void>(1);
    const poke = Queue.offer(wake, undefined).pipe(Effect.asVoid);
    // A failed update waits for a newer release or a manual retry instead of looping.
    const attempted = new Map<ProviderInstanceId, string>();

    yield* watchAgentWork("provider auto-update", Effect.never, (instanceIds) =>
      Ref.set(activeInstanceIds, instanceIds).pipe(Effect.andThen(poke)),
    );
    yield* forkParked(Stream.runForEach(registry.streamChanges, () => poke));

    const updateNext = Effect.gen(function* () {
      const active = yield* Ref.get(activeInstanceIds);
      if (active === null) return;
      const provider = nextAutoUpdate({
        providers: yield* registry.getProviders,
        activeInstanceIds: active,
        attempted,
      });
      if (provider === undefined) return;
      const latestVersion = provider.versionAdvisory?.latestVersion ?? "";
      attempted.set(provider.instanceId, latestVersion);
      yield* Effect.logInfo("updating provider while none of its threads are working", {
        instanceId: provider.instanceId,
        driver: provider.driver,
        from: provider.versionAdvisory?.currentVersion ?? null,
        to: latestVersion,
      });
      yield* runner
        .updateProvider({ provider: provider.driver, instanceId: provider.instanceId })
        .pipe(
          Effect.catch((error) =>
            Effect.logWarning("automatic provider update failed", {
              instanceId: provider.instanceId,
              error,
            }),
          ),
        );
      // Another provider may be waiting behind this one.
      yield* poke;
    });

    yield* forkParked(Queue.take(wake).pipe(Effect.andThen(updateNext), Effect.forever));
  }),
).pipe(Layer.provide(ProviderMaintenanceRunner.layer));
