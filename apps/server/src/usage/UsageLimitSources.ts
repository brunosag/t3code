import {
  DEFAULT_PROVIDER_HEALTH_REFRESH_INTERVAL,
  UsageLimitSourceError,
  type UsageLimitSourceConsumeResetCreditInput,
  type UsageLimitSourceSetAccountOrderInput,
  type UsageLimitSourceSetAccountDisabledInput,
  type ProviderConsumeResetCreditResult,
  type ProviderDriverKind,
  type ServerSettings,
  UsageLimitSourceConfig,
  settingsSecretLiteral,
  type UsageLimitSourceId,
  type UsageLimitSourceSnapshot,
} from "@t3tools/contracts";
import { resolveServerBackgroundActivitySettings } from "@t3tools/shared/backgroundActivitySettings";
import { compareSemverVersions } from "@t3tools/shared/semver";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as SecretResolverLayer from "../secrets/SecretResolver.ts";
import { resolveSettingsSecrets } from "../secrets/settingsSecretValue.ts";
import * as Settings from "../serverSettings.ts";
import { windowLimitsModel } from "../provider/claudeUsageLimits.ts";
import { makeCliproxyApi } from "./cliproxyApi.ts";
import { UsageLimitHistory } from "./UsageLimitHistory.ts";

export class UsageLimitSources extends Context.Service<
  UsageLimitSources,
  {
    readonly current: Effect.Effect<ReadonlyArray<UsageLimitSourceSnapshot>>;
    readonly streamChanges: Stream.Stream<ReadonlyArray<UsageLimitSourceSnapshot>>;
    readonly refresh: Effect.Effect<void>;
    readonly consumeResetCredit: (
      input: UsageLimitSourceConsumeResetCreditInput,
    ) => Effect.Effect<ProviderConsumeResetCreditResult, UsageLimitSourceError>;
    readonly setAccountOrder: (
      input: UsageLimitSourceSetAccountOrderInput,
    ) => Effect.Effect<void, UsageLimitSourceError>;
    readonly setAccountDisabled: (
      input: UsageLimitSourceSetAccountDisabledInput,
    ) => Effect.Effect<void, UsageLimitSourceError>;
    /** When a hub that refused a Claude model on every credential can route it again. */
    readonly claudeCooldownResetAt: (model: string) => Effect.Effect<string | undefined>;
    /** Claude offers reset grants only to a recent Claude Code, so hub reads present the newest installed. */
    readonly reportClaudeVersion: (version: string) => Effect.Effect<void>;
  }
>()("t3/usage/UsageLimitSources") {}

function sourceLabel(id: string, config: UsageLimitSourceConfig): string {
  if (config.label) return config.label;
  const fallback = id.trim() || "Usage limit source";
  try {
    return new URL(config.url).host || fallback;
  } catch {
    return fallback;
  }
}

// Anthropic's usage endpoint answers 429 to close reads, so one failure keeps the last good reading.
const CARRY_READING_FOR_MS = 60 * 60 * 1000;

function missingManagementKey(config: UsageLimitSourceConfig): string {
  return typeof config.managementKey === "string"
    ? "No management key configured."
    : "Could not read the management key from its secret provider.";
}

/** @public */
export const make = Effect.gen(function* () {
  const api = yield* makeCliproxyApi;
  const settingsService = yield* Settings.ServerSettingsService;
  const history = yield* Effect.serviceOption(UsageLimitHistory);
  const secrets = yield* SecretResolver.SecretResolver;
  const readManagementKey = Effect.fn("UsageLimitSources.readManagementKey")(function* (
    config: UsageLimitSourceConfig,
  ) {
    const resolved = yield* resolveSettingsSecrets(secrets, UsageLimitSourceConfig, config);
    return settingsSecretLiteral(resolved.managementKey);
  });
  const stateRef = yield* Ref.make<ReadonlyArray<UsageLimitSourceSnapshot>>([]);
  const claudeVersion = yield* Ref.make<string | undefined>(undefined);
  const changes = yield* Effect.acquireRelease(
    PubSub.unbounded<ReadonlyArray<UsageLimitSourceSnapshot>>(),
    PubSub.shutdown,
  );

  const readSource = Effect.fn("UsageLimitSources.readSource")(function* (
    id: UsageLimitSourceId,
    config: UsageLimitSourceConfig,
  ) {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const url = URL.parse(config.url);
    const base = {
      id,
      kind: config.kind,
      label: sourceLabel(id, config),
      ...(url && /^https?:$/.test(url.protocol) ? { origin: url.origin } : {}),
      checkedAt,
    } as const;
    const managementKey = yield* readManagementKey(config);
    if (managementKey.length === 0) {
      return { ...base, accounts: [], error: missingManagementKey(config) };
    }
    const accounts = yield* api
      .readAccounts({
        url: config.url,
        managementKey,
        claudeVersion: yield* Ref.get(claudeVersion),
      })
      .pipe(Effect.result);
    if (accounts._tag === "Failure") {
      yield* Effect.logDebug("usage limit source read failed", { id, cause: accounts.failure });
      return { ...base, accounts: [], error: accounts.failure.detail };
    }
    const previous = (yield* Ref.get(stateRef)).find((source) => source.id === id)?.accounts;
    const carryFrom = Date.parse(checkedAt) - CARRY_READING_FOR_MS;
    return {
      ...base,
      accounts: accounts.success.map((account) => {
        const kept =
          account.usageLimits.unavailable?.reason === "probeFailed"
            ? previous?.find(
                (candidate) =>
                  candidate.id === account.id &&
                  !candidate.usageLimits.unavailable &&
                  candidate.usageLimits.windows.length > 0 &&
                  Date.parse(candidate.usageLimits.checkedAt) > carryFrom,
              )
            : undefined;
        return {
          ...account,
          ...(kept
            ? {
                plan: account.plan ?? kept.plan,
                capacity: account.capacity ?? kept.capacity,
                usageLimits: kept.usageLimits,
              }
            : {}),
          ...config.accounts?.[account.id],
        };
      }),
    };
  });

  const publish = Effect.fn("UsageLimitSources.publish")(function* (
    read: ReadonlyArray<UsageLimitSourceSnapshot>,
  ) {
    const next = Option.isSome(history) ? yield* history.value.annotate(read) : read;
    const changed = yield* Ref.modify(stateRef, (previous) =>
      Equal.equals(previous, next) ? [false, previous] : [true, next],
    );
    if (changed) yield* PubSub.publish(changes, next);
  });

  // Serialize refreshes so slow old-settings reads cannot resurrect removed sources after newer refreshes.
  const refreshLock = yield* Semaphore.make(1);
  const refresh = Effect.gen(function* () {
    const settings = yield* settingsService.getSettings.pipe(
      Effect.orElseSucceed((): ServerSettings | null => null),
    );
    const entries = Object.entries(settings?.usageLimitSources ?? {}).filter(
      ([, config]) => config.enabled,
    );
    const snapshots = yield* Effect.forEach(
      entries,
      ([id, config]) => readSource(id as UsageLimitSourceId, config),
      { concurrency: 4 },
    );
    yield* publish(snapshots);
  }).pipe(refreshLock.withPermits(1), Effect.ignoreCause({ log: true }));

  const enabledHub = Effect.fn("UsageLimitSources.enabledHub")(function* (
    sourceId: UsageLimitSourceId,
  ) {
    const settings = yield* settingsService.getSettings.pipe(
      Effect.mapError(() => new UsageLimitSourceError({ detail: "Could not read hub settings." })),
    );
    const config = settings.usageLimitSources[sourceId];
    if (!config?.enabled) {
      return yield* new UsageLimitSourceError({
        detail: "The usage limit source is missing or disabled.",
      });
    }
    const managementKey = yield* readManagementKey(config);
    if (managementKey.length === 0) {
      return yield* new UsageLimitSourceError({ detail: missingManagementKey(config) });
    }
    return {
      config,
      hub: { url: config.url, managementKey, claudeVersion: yield* Ref.get(claudeVersion) },
    };
  });

  // Shares the refresh lock so a stale in-flight read cannot overwrite a redemption.
  const consumeResetCredit = Effect.fn("UsageLimitSources.consumeResetCredit")(function* (
    input: UsageLimitSourceConsumeResetCreditInput,
  ) {
    const { config, hub } = yield* enabledHub(input.sourceId);
    const result = yield* api.consume(hub, input.accountId, input.creditId);
    const snapshot = yield* readSource(input.sourceId, config);
    const previous = yield* Ref.get(stateRef);
    yield* publish(previous.map((source) => (source.id === input.sourceId ? snapshot : source)));
    return result;
  }, refreshLock.withPermits(1));

  // Patches the published priorities in place: re-reading every account's usage takes seconds.
  const setAccountOrder = Effect.fn("UsageLimitSources.setAccountOrder")(function* (
    input: UsageLimitSourceSetAccountOrderInput,
  ) {
    const { hub } = yield* enabledHub(input.sourceId);
    const priorities = yield* api.setAccountOrder(hub, input.driver, input.accountIds);
    const previous = yield* Ref.get(stateRef);
    yield* publish(
      previous.map((source) =>
        source.id === input.sourceId
          ? {
              ...source,
              accounts: source.accounts.map((account) => {
                const priority = priorities.get(account.id);
                return priority === undefined ? account : { ...account, priority };
              }),
            }
          : source,
      ),
    );
  }, refreshLock.withPermits(1));

  const setAccountDisabled = Effect.fn("UsageLimitSources.setAccountDisabled")(function* (
    input: UsageLimitSourceSetAccountDisabledInput,
  ) {
    const { config, hub } = yield* enabledHub(input.sourceId);
    const account = yield* api.setAccountDisabled(hub, input.accountId, input.disabled);
    const labeled = { ...account, ...config.accounts?.[account.id] };
    const previous = yield* Ref.get(stateRef);
    yield* publish(
      previous.map((source) =>
        source.id === input.sourceId
          ? {
              ...source,
              accounts: source.accounts.some((candidate) => candidate.id === account.id)
                ? source.accounts.map((candidate) =>
                    candidate.id === account.id ? labeled : candidate,
                  )
                : [...source.accounts, labeled],
            }
          : source,
      ),
    );
  }, refreshLock.withPermits(1));

  const claudeCooldownResetAt = Effect.fn("UsageLimitSources.claudeCooldownResetAt")(function* (
    model: string,
  ) {
    const settings = yield* settingsService.getSettings.pipe(Effect.orElseSucceed(() => null));
    const ends = yield* Effect.forEach(
      Object.values(settings?.usageLimitSources ?? {}).filter((config) => config.enabled),
      (config) =>
        readManagementKey(config).pipe(
          Effect.flatMap((managementKey) =>
            managementKey.length > 0
              ? api.claudeCooldownEnd({ url: config.url, managementKey }, model)
              : Effect.undefined,
          ),
          Effect.timeout("5 seconds"),
          Effect.tapCause((cause) =>
            Effect.logDebug("usage limit source cooldown read failed", { cause }),
          ),
          Effect.orElseSucceed(() => undefined),
        ),
      { concurrency: 4 },
    );
    const soonest = Math.min(...ends.filter((end) => end !== undefined));
    return Number.isFinite(soonest) ? DateTime.formatIso(DateTime.makeUnsafe(soonest)) : undefined;
  });

  const scope = yield* Effect.scope;
  // A newer version can unlock grants the last read missed, so it rereads the hubs.
  const reportClaudeVersion = Effect.fn("UsageLimitSources.reportClaudeVersion")(function* (
    version: string,
  ) {
    const raised = yield* Ref.modify(claudeVersion, (current) =>
      current === undefined || compareSemverVersions(version, current) > 0
        ? [true, version]
        : [false, current],
    );
    if (raised) yield* refresh.pipe(Effect.forkIn(scope));
  });

  yield* settingsService.streamChanges.pipe(
    Stream.map((settings) => settings.usageLimitSources),
    Stream.changes,
    Stream.runForEach(() => refresh),
    Effect.forkScoped,
  );

  const interval = settingsService.getSettings.pipe(
    Effect.map(
      (settings) => resolveServerBackgroundActivitySettings(settings).providerHealthRefreshInterval,
    ),
    Effect.orElseSucceed(() => DEFAULT_PROVIDER_HEALTH_REFRESH_INTERVAL),
  );
  // Runs with no client open too, so the recorded history has no gaps while nobody looks.
  yield* Effect.forever(
    interval.pipe(
      Effect.flatMap((wait) => Effect.sleep(Duration.isPositive(wait) ? wait : "60 seconds")),
      Effect.andThen(interval),
      Effect.flatMap((current) => (Duration.isPositive(current) ? refresh : Effect.void)),
      Effect.ignoreCause({ log: true }),
    ),
  ).pipe(Effect.forkScoped);

  yield* refresh.pipe(Effect.forkScoped);

  return {
    current: Ref.get(stateRef),
    consumeResetCredit,
    setAccountOrder,
    setAccountDisabled,
    claudeCooldownResetAt,
    reportClaudeVersion,
    refresh,
    get streamChanges() {
      return Stream.unwrap(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(changes);
          const snapshot = yield* Ref.get(stateRef);
          return Stream.concat(Stream.make(snapshot), Stream.fromSubscription(subscription)).pipe(
            Stream.changes,
          );
        }),
      );
    },
  } satisfies UsageLimitSources["Service"];
});

export const layer = Layer.effect(UsageLimitSources, make).pipe(
  Layer.provide(SecretResolverLayer.layer),
);

/** A hub answers with a usage limit only when every account it routes the driver to is spent. */
export function hubPoolResetAt(
  sources: ReadonlyArray<UsageLimitSourceSnapshot>,
  driver: ProviderDriverKind,
  model: string | null,
  now: number,
): string | null {
  let earliest: number | null = null;
  for (const source of sources) {
    for (const account of source.accounts) {
      if (account.driver !== driver) continue;
      // An unread account may be the one still blocked, so its refill is unknown.
      if (account.usageLimits.unavailable) return null;
      const spent = account.usageLimits.windows.filter(
        (window) => window.usedPercent >= 100 && windowLimitsModel(window, model),
      );
      if (spent.length === 0) return null;
      const resets = spent.map((window) => Date.parse(window.resetsAt ?? ""));
      if (resets.some((reset) => !Number.isFinite(reset))) return null;
      const recoversAt = Math.max(...resets);
      if (recoversAt <= now) return null;
      earliest = earliest === null ? recoversAt : Math.min(earliest, recoversAt);
    }
  }
  return earliest === null ? null : DateTime.formatIso(DateTime.makeUnsafe(earliest));
}

export class UsageLimitResetFallback extends Context.Reference<{
  readonly resetAt: (
    driver: ProviderDriverKind,
    endpoint: string,
    model: string | null,
  ) => Effect.Effect<string | null>;
}>("t3/usage/UsageLimitResetFallback", {
  defaultValue: () => ({ resetAt: () => Effect.succeed(null) }),
}) {}

export const layerResetFallback = Layer.effect(
  UsageLimitResetFallback,
  Effect.gen(function* () {
    const sources = yield* UsageLimitSources;
    return {
      resetAt: Effect.fn("UsageLimitResetFallback.resetAt")(function* (driver, endpoint, model) {
        // Only the hub at the instance's endpoint serves its turns.
        const atEndpoint = Effect.map(sources.current, (current) =>
          current.filter((source) => source.origin === endpoint),
        );
        if ((yield* atEndpoint).length === 0) return null;
        // The pool usually ran out after the last poll, so the cached accounts still show room.
        yield* sources.refresh.pipe(Effect.timeout("5 seconds"), Effect.ignore);
        return hubPoolResetAt(
          yield* atEndpoint,
          driver,
          model,
          DateTime.toEpochMillis(yield* DateTime.now),
        );
      }),
    };
  }),
);
