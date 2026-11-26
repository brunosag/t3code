import {
  type EnvironmentId,
  type ModelSelection,
  type ServerSettings,
  type ProjectId,
  resolveProjectProviderInstanceEnabled,
  type UsageLimitsReport,
  type ProviderInstanceId,
  type ProviderConsumeResetCreditInput,
  type ServerProviderSlashCommand,
  isProviderAvailable,
  PROVIDER_DISPLAY_NAMES,
  type ServerProvider,
  type ServerProviderUsageLimits,
  type ServerProviderUsageWindow,
  type UsageLimitSourceId,
  type UsageLimitSourceAccount,
  type UsageLimitSourceSnapshot,
  type UsageLimitSourceSnapshots,
  DEFAULT_PROVIDER_HEALTH_REFRESH_INTERVAL,
} from "@t3tools/contracts";

import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";

import { isLocalLoopbackHost, isWildcardHost } from "./hostClassification.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function exhaustedUsageWindow(
  provider: ServerProvider | undefined,
  now: number,
  model?: string,
) {
  const windows = provider?.usageLimits?.windows ?? [];
  const exhausted = windows.filter(
    (window) =>
      (window.usedPercent ?? 0) >= 100 &&
      (model === undefined || window.modelIds === undefined || window.modelIds.includes(model)) &&
      (model === undefined ||
        window.providerIds === undefined ||
        window.providerIds.includes(model.split("/")[0] ?? "")) &&
      (!window.resetsAt ||
        !Number.isFinite(Date.parse(window.resetsAt)) ||
        Date.parse(window.resetsAt) > now),
  );
  if (model === undefined) return exhausted[0];
  switch (provider?.driver) {
    case "cursor": {
      const api = exhausted.find((window) => window.id === "apiPercentUsed");
      const auto = exhausted.find((window) => window.id === "autoPercentUsed");
      return /^(auto|default|grok|composer)/.test(model) ? auto && api : api;
    }
    case "codex": {
      // Seat-based plans spend credits only past their plan windows, so the credit cap blocks only plans without them.
      const hasPlanWindows = windows.some(
        (window) => window.id === "primary" || window.id === "secondary",
      );
      return exhausted.find((window) => window.id !== "individual" || !hasPlanWindows);
    }
    case "opencode":
      return exhausted.find(
        (window) => !window.id.startsWith("go_") || model.startsWith("opencode-go/"),
      );
    default:
      return exhausted[0];
  }
}

export function resolveNewThreadModelSelection(input: {
  readonly defaultSelection: ModelSelection | null;
  readonly explicitSelection?: ModelSelection | null;
  readonly fallbackSelection: ModelSelection | null;
  readonly providers: readonly ServerProvider[];
  readonly now: number;
  readonly settings?: ServerSettings;
  readonly projectId?: ProjectId | null;
}) {
  const selection = input.explicitSelection ?? input.defaultSelection;
  const unchanged = { selection, fallback: null };
  if (input.explicitSelection || !selection || !input.fallbackSelection) return unchanged;
  const provider = input.providers.find((entry) => entry.instanceId === selection.instanceId);
  const window = exhaustedUsageWindow(provider, input.now, selection.model);
  const fallback = input.providers.find(
    (entry) => entry.instanceId === input.fallbackSelection?.instanceId,
  );
  if (
    !provider ||
    !window ||
    !fallback?.enabled ||
    !fallback.installed ||
    fallback.auth.status === "unauthenticated" ||
    !isProviderAvailable(fallback) ||
    exhaustedUsageWindow(fallback, input.now, input.fallbackSelection.model) ||
    (input.settings &&
      !resolveProjectProviderInstanceEnabled(
        input.settings,
        input.projectId ?? null,
        fallback.instanceId,
      ))
  )
    return unchanged;
  return {
    selection: input.fallbackSelection,
    fallback: { provider, resetsAt: window.resetsAt ?? null },
  };
}

export const CHATGPT_USAGE_URL = "https://chatgpt.com/#settings/Usage";
export const CHATGPT_USAGE_LIMIT_CODE = "subscription_sharing_usage_limit_exceeded";
/** A ChatGPT Business admin caps plan use in other apps; only the admin can raise it. */
export const CHATGPT_WORKSPACE_USAGE_LIMIT_CODE =
  "subscription_sharing_workplace_individual_usage_limit_exceeded";
/** OpenAI's partner guidelines fix this wording; the user sends it to their admin themselves. */
export const CHATGPT_WORKSPACE_ADMIN_REQUEST =
  "I've reached the limit for using my ChatGPT plan in T3 Code. Could you increase our workspace's usage limits so I can continue?\n\nGo to admin.openai.com → Workspace → Usage limits. Thank you!";

export function usesChatGptSharing(provider: ServerProvider | null | undefined): boolean {
  return provider?.auth.status === "authenticated" && provider.auth.subscriptionSharing === true;
}

export const CURSOR_USAGE_WINDOWS = [
  {
    id: "totalPercentUsed",
    label: "Overall",
    description: "All usage on your plan this billing cycle.",
  },
  {
    id: "autoPercentUsed",
    label: "Cursor Models",
    description: "Grok, Composer, and Auto use this allowance.",
  },
  {
    id: "apiPercentUsed",
    label: "Other Models",
    description: "Usage allowance for third-party models such as Claude, GPT, and Gemini.",
  },
] as const;

export function cursorUsageWindowDetails(id: string, pool: LimitPool) {
  const details = CURSOR_USAGE_WINDOWS.find((window) => window.id === id);
  return details &&
    ((pool.windows.length === 1 && id === "totalPercentUsed") || hasDuplicateCursorTotal(pool))
    ? { ...details, label: null, description: undefined }
    : details;
}

function cursorUsageWindowRank(id: string): number {
  const rank = CURSOR_USAGE_WINDOWS.findIndex((window) => window.id === id);
  return rank < 0 ? CURSOR_USAGE_WINDOWS.length : rank;
}

export function providersWithLimits(
  providers: readonly ServerProvider[],
): readonly ServerProvider[] {
  return providers.filter(
    (provider) =>
      provider.enabled &&
      provider.installed &&
      isProviderAvailable(provider) &&
      provider.usageLimits !== undefined,
  );
}

export type LimitPresentations = ReadonlyMap<
  EnvironmentId,
  {
    readonly entry: { readonly target: { readonly label: string } };
    readonly serverConfig: {
      readonly providers: readonly ServerProvider[];
      readonly usageLimitSources?: UsageLimitSourceSnapshots | undefined;
    } | null;
  }
>;

export function collectExternalUsageLinks(
  presentations: LimitPresentations,
  accountLabel = (provider: string, environment: string) => `${provider} on ${environment}`,
) {
  const links = new Map<
    string,
    {
      readonly label: string;
      readonly url: string;
      readonly message: string | undefined;
      readonly accounts: readonly string[];
    }
  >();
  for (const presentation of presentations.values()) {
    for (const provider of providersWithLimits(presentation.serverConfig?.providers ?? [])) {
      const external = provider.usageLimits?.externalUsage;
      if (external && provider.auth.status === "authenticated") {
        const account = accountLabel(
          provider.displayName ?? provider.instanceId,
          presentation.entry.target.label,
        );
        links.set(external.url, {
          ...external,
          message: provider.usageLimits?.unavailable?.message,
          accounts: [...new Set([...(links.get(external.url)?.accounts ?? []), account])],
        });
      }
    }
  }
  return [...links.values()];
}

function accountKey(
  driver: ServerProvider["driver"],
  email: string | undefined,
  limits?: ServerProviderUsageLimits,
): string | null {
  const normalizedEmail = email?.trim().toLowerCase();
  if (normalizedEmail) return `${driver}:${normalizedEmail}`;
  return limits?.credentialFingerprint
    ? `${driver}:credential:${limits.credentialFingerprint}`
    : null;
}

interface AccountReport {
  readonly driver: ServerProvider["driver"];
  readonly email?: string | undefined;
  readonly workspaceId?: string | undefined;
  readonly usageLimits?: ServerProviderUsageLimits | undefined;
}

const nativeReport = (provider: ServerProvider): AccountReport => ({
  driver: provider.driver,
  email: provider.auth.email,
  workspaceId: provider.auth.workspaceId,
  usageLimits: provider.usageLimits,
});

// Include every enabled login, even unreadable workspaces.
function accountKeyResolver(reports: Iterable<AccountReport>) {
  const workspaces = new Map<string, Set<string>>();
  for (const report of reports) {
    const key = accountKey(report.driver, report.email, report.usageLimits);
    if (key && report.workspaceId) {
      workspaces.set(key, (workspaces.get(key) ?? new Set()).add(report.workspaceId));
    }
  }
  return (report: AccountReport): string | null => {
    const key = accountKey(report.driver, report.email, report.usageLimits);
    if (!key) return null;
    if (report.workspaceId) return `${key}:${report.workspaceId}`;
    const known = workspaces.get(key);
    if (!known) return key;
    return known.size === 1 ? `${key}:${[...known][0]}` : null;
  };
}

const hubAccountName = (account: { readonly id: string }) => account.id.replace(/\.json$/i, "");

function limitAccountKeyResolver(presentations: LimitPresentations) {
  return accountKeyResolver(
    [...presentations.values()].flatMap((presentation) => [
      ...(presentation.serverConfig?.providers ?? [])
        .filter((provider) => provider.enabled)
        .map(nativeReport),
      ...(presentation.serverConfig?.usageLimitSources ?? []).flatMap((source) => source.accounts),
    ]),
  );
}

const nativeRowKey = (
  resolveKey: ReturnType<typeof accountKeyResolver>,
  environmentId: EnvironmentId,
  provider: ServerProvider,
) => resolveKey(nativeReport(provider)) ?? `${environmentId}:${provider.instanceId}`;

const hubRowKey = (
  resolveKey: ReturnType<typeof accountKeyResolver>,
  environmentId: EnvironmentId,
  source: UsageLimitSourceSnapshot,
  account: UsageLimitSourceAccount,
) =>
  resolveKey(account) ??
  `${hubIdentity(environmentId, source)}:${account.id}${account.workspaceId ? `:${account.workspaceId}` : ""}`;

// Source ids are environment-local, so only a remote endpoint names the same hub across environments.
function hubIdentity(environmentId: EnvironmentId, source: UsageLimitSourceSnapshot): string {
  // The server supplies canonical endpoints; native URL polyfills can misparse IPv6 hosts.
  const endpoint = source.endpoint;
  const host = endpoint?.match(/^https?:\/\/(\[[\da-f:.]+\]|[^:/?#@]+)(?::\d+)?(?:\/|$)/)?.[1];
  const local =
    !host ||
    isLocalLoopbackHost(host) ||
    isWildcardHost(host) ||
    // Each machine resolves these to itself too; shared host classification leaves them out.
    /\.localhost\.*$|^\[::ffff:(?:127\.|7f[\da-f]{2}:)/i.test(host);
  return endpoint && !local ? endpoint : `${environmentId}:${source.id}`;
}

export interface LimitAccount {
  readonly key: string;
  readonly driver: ServerProvider["driver"];
  readonly displayName: string | null;
  readonly email: string | undefined;
  readonly plan: string | undefined;
  /** Quota size relative to the driver's other accounts; unknown for native logins. */
  readonly capacity: number | undefined;
  readonly accentColor: string | undefined;
  readonly image: string | undefined;
  readonly environments: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly label: string;
  }>;
  readonly sourceLabel: string | null;
  readonly redeem: {
    readonly environmentId: EnvironmentId;
    readonly input: ProviderConsumeResetCreditInput;
  } | null;
  /** The hub login whose place in its pool sets the hub's routing priority. */
  readonly routing: {
    readonly environmentId: EnvironmentId;
    readonly sourceId: UsageLimitSourceId;
    readonly accountId: string;
    readonly priority: number;
    /** The server keeps this hub's logins for the driver in earliest-reset order. */
    readonly byReset: boolean;
  } | null;
  /** No hub routes to this login and no environment signs in with it, so pools leave it out. */
  readonly disabled: boolean;
  /** The hub's last read of this login failed, so `limits` is an earlier reading. */
  readonly stale: boolean;
  readonly limits: ServerProviderUsageLimits;
}

// Hubs are re-read every refresh interval (five minutes by default), and a failed read is
// common, so a carried reading is only worth a notice once about two reads have gone by.
const STALE_READING_NOTICE_AFTER_MS =
  2 * Duration.toMillis(DEFAULT_PROVIDER_HEALTH_REFRESH_INTERVAL);

/** Switched-on logins whose carried reading is old enough to mention. */
export function staleLimitAccounts(accounts: readonly LimitAccount[], now: number): LimitAccount[] {
  return accounts.filter(
    (account) =>
      account.stale &&
      !account.disabled &&
      now - Date.parse(account.limits.checkedAt) >= STALE_READING_NOTICE_AFTER_MS,
  );
}

/** Accounts sharing a key are reordered together; null for accounts no hub routes. */
export function limitRoutingKey(account: LimitAccount): string | null {
  return account.routing ? `${account.routing.environmentId}:${account.routing.sourceId}` : null;
}

type UsageHistory = NonNullable<ServerProviderUsageWindow["history"]>;

/** Each server records only while it runs, so a step either one saw fills the other's gap. */
function mergeHistory(
  preferred: UsageHistory | undefined,
  other: UsageHistory | undefined,
): UsageHistory | undefined {
  if (!preferred || !other) return preferred ?? other;
  const stepMins = preferred.stepMins ?? 60;
  if ((other.stepMins ?? 60) !== stepMins) return preferred;
  const step = stepMins * 60_000;
  const steps = new Map<number, number>();
  for (const history of [other, preferred]) {
    const start = Date.parse(history.startsAt);
    history.usedPercent.forEach((used, index) => {
      if (used !== null) steps.set(start + index * step, used);
    });
  }
  if (steps.size === 0) return preferred;
  const first = Math.min(...steps.keys());
  const count = Math.round((Math.max(...steps.keys()) - first) / step) + 1;
  return {
    startsAt: DateTime.formatIso(DateTime.makeUnsafe(first)),
    stepMins,
    usedPercent: Array.from(
      { length: count },
      (_, index) => steps.get(first + index * step) ?? null,
    ),
  };
}

// Only hub sources record readings, so keep them when another report of the login is fresher.
function keepHistory(
  windows: ReadonlyArray<ServerProviderUsageWindow>,
  other: ReadonlyArray<ServerProviderUsageWindow>,
): ReadonlyArray<ServerProviderUsageWindow> {
  return windows.map((window) => {
    const history = mergeHistory(
      window.history,
      other.find((candidate) => candidate.id === window.id)?.history,
    );
    return history ? { ...window, history } : window;
  });
}

export function collectHttpQuotaSources(presentations: Parameters<typeof collectLimitAccounts>[0]) {
  return [...presentations].flatMap(([environmentId, presentation]) =>
    (presentation.serverConfig?.usageLimitSources ?? []).flatMap((source) =>
      source.kind === "http" && source.quotaAccounts?.length
        ? [
            {
              ...source,
              key: `${environmentId}:${source.id}`,
              label:
                presentations.size > 1
                  ? `${presentation.entry.target.label} · ${source.label}`
                  : source.label,
            },
          ]
        : [],
    ),
  );
}

export function collectLimitAccounts(presentations: LimitPresentations): readonly LimitAccount[] {
  const accounts = new Map<string, LimitAccount>();
  const creditSources = new Map<string, LimitAccount>();
  const hubRedeems = new Map<string, LimitAccount>();
  const planSources = new Map<string, LimitAccount>();
  const merge = (key: string, next: LimitAccount) => {
    // Prefer hub redemption to clear its routing cooldown too; displayed balance still follows the freshest read.
    const previousHub = hubRedeems.get(key);
    if (
      next.redeem &&
      "sourceId" in next.redeem.input &&
      (!previousHub || Date.parse(next.limits.checkedAt) > Date.parse(previousHub.limits.checkedAt))
    ) {
      hubRedeems.set(key, next);
    }
    const previousCredit = creditSources.get(key);
    if (
      next.limits.resetCredits &&
      (!previousCredit ||
        Date.parse(next.limits.checkedAt) > Date.parse(previousCredit.limits.checkedAt))
    ) {
      creditSources.set(key, next);
    }
    const previousPlan = planSources.get(key);
    // A plan with a known size beats a sign-in label such as a local Antigravity's "Google account".
    const sized = (account: LimitAccount) => account.capacity !== undefined;
    if (
      next.plan &&
      (!previousPlan ||
        (sized(next) === sized(previousPlan)
          ? Date.parse(next.limits.checkedAt) > Date.parse(previousPlan.limits.checkedAt)
          : sized(next)))
    ) {
      planSources.set(key, next);
    }
    const previous = accounts.get(key);
    if (!previous) {
      accounts.set(key, next);
      return;
    }
    const fresher = Date.parse(next.limits.checkedAt) > Date.parse(previous.limits.checkedAt);
    const environments = [
      ...previous.environments,
      ...next.environments.filter(
        (candidate) =>
          !previous.environments.some((seen) => seen.environmentId === candidate.environmentId),
      ),
    ];
    const winner = fresher ? next : previous;
    const creditSource = creditSources.get(key);
    // A hub e-mail names the account better than the driver's default instance name.
    const hubEmail = [previous, next].some(
      (account) => account.environments.length === 0 && account.email,
    );
    const displayName = previous.displayName ?? next.displayName;
    accounts.set(key, {
      ...previous,
      displayName:
        hubEmail &&
        displayName?.toLowerCase() === PROVIDER_DISPLAY_NAMES[previous.driver]?.toLowerCase()
          ? null
          : displayName,
      plan: planSources.get(key)?.plan ?? previous.plan ?? next.plan,
      capacity: planSources.get(key)?.capacity ?? previous.capacity ?? next.capacity,
      accentColor: previous.accentColor ?? next.accentColor,
      image: previous.image ?? next.image,
      environments,
      sourceLabel: environments.length > 0 ? null : (previous.sourceLabel ?? next.sourceLabel),
      routing: previous.routing ?? next.routing,
      disabled: previous.disabled && next.disabled,
      stale: winner.stale,
      redeem:
        hubRedeems.get(key)?.redeem ??
        (creditSource ? creditSource.redeem : (winner.redeem ?? previous.redeem ?? next.redeem)),
      limits: {
        ...winner.limits,
        windows: keepHistory(winner.limits.windows, (fresher ? previous : next).limits.windows),
        ...(creditSource?.limits.resetCredits
          ? { resetCredits: creditSource.limits.resetCredits }
          : { resetCredits: undefined }),
      },
    });
  };
  const resolveKey = limitAccountKeyResolver(presentations);
  for (const [environmentId, presentation] of presentations) {
    const label = presentation.entry.target.label;
    for (const provider of providersWithLimits(presentation.serverConfig?.providers ?? [])) {
      if (!provider.usageLimits || limitsNotice(provider.usageLimits) !== null) continue;
      merge(nativeRowKey(resolveKey, environmentId, provider), {
        key: `${environmentId}:${provider.instanceId}`,
        driver: provider.driver,
        displayName: provider.displayName?.trim() || null,
        email: provider.auth.email,
        plan: provider.auth.label,
        capacity: undefined,
        accentColor: provider.accentColor,
        image: undefined,
        environments: [{ environmentId, label }],
        sourceLabel: null,
        redeem: { environmentId, input: { instanceId: provider.instanceId } },
        routing: null,
        disabled: false,
        stale: false,
        limits: provider.usageLimits,
      });
    }
  }
  const labelEnvironment = presentations.size > 1;
  for (const [environmentId, presentation] of presentations) {
    for (const source of presentation.serverConfig?.usageLimitSources ?? []) {
      const sourceLabel = labelEnvironment
        ? `${presentation.entry.target.label} · ${source.label}`
        : source.label;
      for (const account of source.accounts) {
        if (limitsNotice(account.usageLimits) !== null) continue;
        const resolved = resolveKey(account);
        // A resolved account already has an identity; its public key must stay distinct from others'.
        const hub = resolved ? `${environmentId}:${source.id}` : hubIdentity(environmentId, source);
        const key = `${hub}:${account.id}${account.workspaceId ? `:${account.workspaceId}` : ""}`;
        merge(hubRowKey(resolveKey, environmentId, source, account), {
          key,
          driver: account.driver,
          displayName: account.name ?? (account.email ? null : hubAccountName(account)),
          email: account.email,
          plan: account.plan,
          capacity: account.capacity,
          accentColor: undefined,
          image: account.image,
          environments: [],
          sourceLabel,
          routing:
            account.priority === undefined
              ? null
              : {
                  environmentId,
                  sourceId: source.id,
                  accountId: account.id,
                  priority: account.priority,
                  byReset: source.routeByReset?.includes(account.driver) === true,
                },
          disabled: account.disabled === true,
          stale: Date.parse(account.usageLimits.checkedAt) < Date.parse(source.checkedAt),
          redeem: account.usageLimits.resetCredits?.nextCreditId
            ? {
                environmentId,
                input: {
                  sourceId: source.id,
                  accountId: account.id,
                  creditId: account.usageLimits.resetCredits.nextCreditId,
                },
              }
            : null,
          limits: account.usageLimits,
        });
      }
    }
  }
  return [...accounts.values()];
}

/** A login a hub can route, whether or not it routes it now. */
export interface HubLogin {
  readonly key: string;
  readonly driver: ServerProvider["driver"];
  readonly name: string | null;
  readonly email: string | undefined;
  readonly image: string | undefined;
  readonly hubLabel: string;
  /** The hub's own name, without the machine that reads it. */
  readonly hubName: string;
  readonly disabled: boolean;
  readonly environmentId: EnvironmentId;
  readonly sourceId: UsageLimitSourceId;
  readonly accountId: string;
}

export function collectHubLogins(presentations: LimitPresentations): readonly HubLogin[] {
  const labelEnvironment = presentations.size > 1;
  return [...presentations].flatMap(([environmentId, presentation]) =>
    (presentation.serverConfig?.usageLimitSources ?? []).flatMap((source) =>
      source.accounts.map((account) => ({
        key: `${environmentId}:${source.id}:${account.id}`,
        driver: account.driver,
        name: account.name ?? (account.email ? null : hubAccountName(account)),
        email: account.email,
        image: account.image,
        hubLabel: labelEnvironment
          ? `${presentation.entry.target.label} · ${source.label}`
          : source.label,
        hubName: source.label,
        disabled: account.disabled === true,
        environmentId,
        sourceId: source.id,
        accountId: account.id,
      })),
    ),
  );
}

/** Hub accounts whose read failed and that no other report shows as a row, with their names. */
export function unshownFailedHubAccounts(
  presentations: LimitPresentations,
): ReadonlyMap<UsageLimitSourceAccount, string> {
  const resolveKey = limitAccountKeyResolver(presentations);
  const shownRows = new Set<string>();
  for (const [environmentId, presentation] of presentations) {
    for (const provider of providersWithLimits(presentation.serverConfig?.providers ?? [])) {
      if (provider.usageLimits && limitsNotice(provider.usageLimits) === null) {
        shownRows.add(nativeRowKey(resolveKey, environmentId, provider));
      }
    }
    for (const source of presentation.serverConfig?.usageLimitSources ?? []) {
      for (const account of source.accounts) {
        if (limitsNotice(account.usageLimits) === null) {
          shownRows.add(hubRowKey(resolveKey, environmentId, source, account));
        }
      }
    }
  }
  const failed = new Map<UsageLimitSourceAccount, string>();
  for (const [environmentId, presentation] of presentations) {
    for (const source of presentation.serverConfig?.usageLimitSources ?? []) {
      for (const account of source.accounts) {
        if (account.disabled) continue;
        if (account.usageLimits.unavailable?.reason !== "probeFailed") continue;
        if (shownRows.has(hubRowKey(resolveKey, environmentId, source, account))) continue;
        failed.set(account, account.email ?? hubAccountName(account));
      }
    }
  }
  return failed;
}

export interface LimitPoolMember {
  readonly account: LimitAccount;
  readonly window: ServerProviderUsageWindow;
  readonly refillPercent: number;
  /** This account's part of the pool's quota; the pool's shares sum to 1. */
  readonly share: number;
}

export interface LimitPoolWindow {
  readonly id: string;
  readonly kind: ServerProviderUsageWindow["kind"];
  readonly label: string;
  readonly members: readonly LimitPoolMember[];
  /** Switched-off logins' readings, shown beside the pool but left out of its totals. */
  readonly offMembers: ReadonlyArray<Omit<LimitPoolMember, "share">>;
  readonly columns: ReadonlyArray<
    LimitPoolMember | { readonly account: LimitAccount; readonly window: null }
  >;
  readonly remainingPercent: number;
  readonly usedPercent: number;
  readonly pace: LimitPace | null;
  readonly resets: ReadonlyArray<{
    readonly member: LimitPoolMember;
    readonly at: number;
    readonly restoresPercent: number;
  }>;
}

export interface LimitPool {
  readonly driver: ServerProvider["driver"];
  readonly accounts: readonly LimitAccount[];
  readonly windows: readonly LimitPoolWindow[];
}

function hasDuplicateCursorTotal(pool: LimitPool): boolean {
  if (pool.windows.length !== 2) return false;
  const total = pool.windows.find((window) => window.id === "totalPercentUsed");
  const auto = pool.windows.find((window) => window.id === "autoPercentUsed");
  return (
    total !== undefined &&
    auto !== undefined &&
    total.members.length === auto.members.length &&
    total.members.every(({ account, window }) =>
      account.limits.windows.some(
        (candidate) =>
          candidate.id === auto.id &&
          candidate.kind === auto.kind &&
          candidate.usedPercent === window.usedPercent &&
          candidate.resetsAt === window.resetsAt,
      ),
    )
  );
}

export function displayLimitWindows(pool: LimitPool) {
  if (pool.driver !== "cursor") return pool.windows;
  const hasAuto = pool.windows.some((window) => window.id === "autoPercentUsed");
  const hasApi = pool.windows.some((window) => window.id === "apiPercentUsed");
  const hideTotal = (hasAuto && hasApi) || hasDuplicateCursorTotal(pool);
  return pool.windows
    .filter((window) => !hideTotal || window.id !== "totalPercentUsed")
    .sort((left, right) => cursorUsageWindowRank(left.id) - cursorUsageWindowRank(right.id));
}

const WINDOW_KIND_ORDER: Record<ServerProviderUsageWindow["kind"], number> = {
  session: 0,
  weekly: 1,
  monthly: 2,
  other: 3,
};

export function collectLimitPools(
  accounts: readonly LimitAccount[],
  now: number,
): readonly LimitPool[] {
  const byDriver = new Map<ServerProvider["driver"], LimitAccount[]>();
  for (const account of accounts) {
    const list = byDriver.get(account.driver);
    if (list) list.push(account);
    else byDriver.set(account.driver, [account]);
  }
  return [...byDriver].map(([driver, members]) => {
    const orderWindow = members
      .flatMap((account) => account.limits.windows)
      .sort((left, right) => WINDOW_KIND_ORDER[left.kind] - WINDOW_KIND_ORDER[right.kind])[0];
    const orderReset = (account: LimitAccount) => {
      const window = account.limits.windows.find(
        (window) => orderWindow && poolKey(driver, window) === poolKey(driver, orderWindow),
      );
      return (
        (window ? resetMillis(poolMember(account, window, now).window) : null) ??
        Number.POSITIVE_INFINITY
      );
    };
    const sorted = [...members].sort(
      (left, right) =>
        Number(left.disabled) - Number(right.disabled) ||
        compareRouting(left, right) ||
        orderReset(left) - orderReset(right) ||
        accountSortName(left).localeCompare(accountSortName(right)) ||
        left.key.localeCompare(right.key),
    );
    const off = sorted.filter((account) => account.disabled);
    return {
      driver,
      accounts: sorted,
      windows: poolWindows(
        sorted.filter((account) => !account.disabled),
        now,
      ).map((pooled) => ({
        ...pooled,
        offMembers: off.flatMap((account) => {
          const reported = account.limits.windows.find(
            (window) =>
              window.kind === pooled.kind && (driver === "codex" || window.id === pooled.id),
          );
          return reported ? [poolMember(account, reported, now)] : [];
        }),
      })),
    };
  });
}

// Hub logins list in routing order, highest priority first, ahead of logins no hub routes.
function compareRouting(left: LimitAccount, right: LimitAccount): number {
  const leftHub = limitRoutingKey(left);
  const rightHub = limitRoutingKey(right);
  if (leftHub !== rightHub) {
    if (leftHub === null) return 1;
    if (rightHub === null) return -1;
    return leftHub.localeCompare(rightHub);
  }
  return (right.routing?.priority ?? 0) - (left.routing?.priority ?? 0);
}

function accountSortName(account: LimitAccount): string {
  return (account.displayName ?? account.email ?? account.key).toLowerCase();
}

const CODEX_PLAN_CAPACITY: Record<string, number> = {
  "ChatGPT Plus Subscription": 1,
  "ChatGPT Pro 100 Subscription": 5,
  "ChatGPT Pro 200 Subscription": 20,
};
// Claude's published plan multipliers describe the session allowance only.
const CLAUDE_SESSION_CAPACITY: Record<string, number> = { Pro: 1, Max: 5, Ultra: 20 };

function planCapacity(account: LimitAccount, kind: ServerProviderUsageWindow["kind"]) {
  if (!account.plan) return undefined;
  if (account.driver === "codex" && (kind === "session" || kind === "weekly")) {
    return CODEX_PLAN_CAPACITY[account.plan];
  }
  if (account.driver === "claudeAgent" && kind === "session") {
    return CLAUDE_SESSION_CAPACITY[account.plan];
  }
  return undefined;
}

// Codex ids name slots, so pool by kind; other drivers' ids identify distinct allowances.
function poolKey(driver: ServerProvider["driver"], window: ServerProviderUsageWindow): string {
  return driver === "codex" ? window.kind : `${window.kind}:${window.id}`;
}

function poolMember(
  account: LimitAccount,
  reported: ServerProviderUsageWindow,
  now: number,
): Omit<LimitPoolMember, "share"> {
  const spentWeekly =
    reported.kind === "session"
      ? account.limits.windows.find(
          (window) =>
            window.usedPercent >= 100 &&
            (account.driver === "claudeAgent"
              ? window.id === "seven_day"
              : account.driver === "codex" && window.kind === "weekly"),
        )
      : undefined;
  if (!spentWeekly) return { account, window: reported, refillPercent: reported.usedPercent };

  const weeklyReset = resetMillis(spentWeekly);
  const sessionReset = resetMillis(reported);
  const cutoff = Math.max(now, Date.parse(account.limits.checkedAt));
  const idleSession = reported.resetsAt === undefined && reported.usedPercent === 0;
  let resetsAt: string | undefined;
  let refillPercent = 0;
  // A stale or missing clock cannot tell us when blocked quota becomes usable,
  // except an unused session that has not started a clock yet.
  if (weeklyReset !== null && weeklyReset > cutoff) {
    if (idleSession) {
      resetsAt = spentWeekly.resetsAt;
      refillPercent = 100;
    } else if (sessionReset !== null && sessionReset > cutoff) {
      if (sessionReset <= weeklyReset) {
        resetsAt = spentWeekly.resetsAt;
        refillPercent = 100;
      } else if (reported.usedPercent >= 100) {
        resetsAt = reported.resetsAt;
        refillPercent = 100;
      } else {
        resetsAt = spentWeekly.resetsAt;
        refillPercent = 100 - Math.max(0, Math.min(100, reported.usedPercent));
      }
    }
  }
  return {
    account,
    // Suppression is not session spending, so it has no session pace clock.
    window: { ...reported, usedPercent: 100, resetsAt, windowDurationMins: undefined },
    refillPercent,
  };
}

/** Neumaier compensated summation. */
function compensatedSum(values: readonly number[]): number {
  let sum = 0;
  let correction = 0;
  for (const value of values) {
    const next = sum + value;
    correction += Math.abs(sum) >= Math.abs(value) ? sum - next + value : value - next + sum;
    sum = next;
  }
  return sum + correction;
}

function poolWindows(accounts: readonly LimitAccount[], now: number): readonly LimitPoolWindow[] {
  const byKey = new Map<string, Omit<LimitPoolMember, "share">[]>();
  for (const account of accounts) {
    for (const reported of account.limits.windows) {
      const member = poolMember(account, reported, now);
      const { window } = member;
      const pooled = poolKey(account.driver, window);
      const key = byKey.get(pooled)?.some((member) => member.account === account)
        ? `${window.kind}:${window.id}`
        : pooled;
      const list = byKey.get(key);
      if (list) list.push(member);
      else byKey.set(key, [member]);
    }
  }
  const pools = [...byKey].map(([key, unweighted]): LimitPoolWindow => {
    // Equal shares unless every account's plan size is known.
    const capacities = unweighted.map(
      (member) => member.account.capacity ?? planCapacity(member.account, member.window.kind),
    );
    const total = capacities.every((capacity) => capacity !== undefined)
      ? capacities.reduce((sum, capacity) => sum + capacity, 0)
      : null;
    const members = unweighted.map((member, index): LimitPoolMember => ({
      ...member,
      share: total === null ? 1 / unweighted.length : (capacities[index] ?? 0) / total,
    }));
    const memberByAccount = new Map(members.map((member) => [member.account.key, member]));
    const first = members[0]!.window;
    const id = members[0]!.account.driver === "codex" ? key : first.id;
    // Sum in value order so reset order cannot change the rounded result.
    const usedPercent = compensatedSum(
      members.map((m) => m.share * m.window.usedPercent).sort((a, b) => a - b),
    );
    // Judge pace only for windows with reset clocks; others add spend without elapsed time.
    const timed = members.flatMap((m) => {
      const share = elapsedShare(m.window, now);
      return share === null
        ? []
        : [{ used: m.window.usedPercent, elapsed: share, weight: m.share }];
    });
    const timedWeight = timed.reduce((sum, t) => sum + t.weight, 0);
    const timedUsed = timed.reduce((sum, t) => sum + t.weight * t.used, 0) / timedWeight;
    const meanElapsed =
      timed.length > 0
        ? timed.reduce((sum, t) => sum + t.weight * t.elapsed, 0) / timedWeight
        : null;
    const resets = members
      .flatMap((member) => {
        const at = resetMillis(member.window);
        return at === null
          ? []
          : [
              {
                member,
                at,
                restoresPercent: Math.round(member.refillPercent * member.share),
              },
            ];
      })
      .sort((left, right) => left.at - right.at);
    return {
      id,
      kind: first.kind,
      label: first.label,
      members,
      offMembers: [],
      columns: accounts.map(
        (account) => memberByAccount.get(account.key) ?? { account, window: null },
      ),
      usedPercent: Math.round(usedPercent),
      remainingPercent: Math.round(100 - usedPercent),
      pace: meanElapsed === null ? null : paceOfShares(timedUsed, meanElapsed),
      resets,
    };
  });
  return pools.sort((left, right) => WINDOW_KIND_ORDER[left.kind] - WINDOW_KIND_ORDER[right.kind]);
}

function limitsNotice(limits: ServerProviderUsageLimits): string | null {
  if (limits.unavailable?.reason === "unsupported") {
    return limits.unavailable.message ?? "This account has no subscription limits.";
  }
  if (limits.unavailable?.reason === "probeFailed") {
    return limits.unavailable.message ?? "Could not read limits.";
  }
  return limits.windows.length === 0 ? "No limits reported." : null;
}

export function remainingPercent(window: ServerProviderUsageWindow): number {
  return Math.round(100 - Math.max(0, Math.min(100, window.usedPercent)));
}

function resetMillis(window: ServerProviderUsageWindow): number | null {
  if (window.resetsAt === undefined) return null;
  const at = Date.parse(window.resetsAt);
  return Number.isFinite(at) ? at : null;
}

export function elapsedShare(window: ServerProviderUsageWindow, now: number): number | null {
  const resetsAt = resetMillis(window);
  if (resetsAt === null || window.windowDurationMins === undefined) return null;
  const length = window.windowDurationMins * MINUTE;
  if (length <= 0) return null;
  return Math.max(0, Math.min(1, (length - (resetsAt - now)) / length));
}

// Bars show quota remaining, so even pace tracks time remaining.
export function paceRemainingPercent(
  window: ServerProviderUsageWindow,
  now: number,
): number | null {
  const elapsed = elapsedShare(window, now);
  return elapsed === null ? null : Math.round((1 - elapsed) * 100);
}

export type LimitPace = "ahead" | "on" | "under";

export function paceOf(window: ServerProviderUsageWindow, now: number): LimitPace | null {
  const elapsed = elapsedShare(window, now);
  return elapsed === null ? null : paceOfShares(window.usedPercent, elapsed);
}

function paceOfShares(usedPercent: number, elapsed: number): LimitPace {
  const gap = usedPercent - elapsed * 100;
  if (gap > 5) return "ahead";
  if (gap < -5) return "under";
  return "on";
}

/** One redeemable reset as clients offer it; `input` already names the chosen credit. */
export interface ResetCreditChoice {
  readonly key: string;
  readonly summary: string;
  readonly actionLabel: string;
  readonly confirmDescription: string;
  readonly availableCount: number;
  readonly input: ProviderConsumeResetCreditInput;
}

/** One kind of banked reset on an account, shown on the row of the window it is mainly for. */
export interface BankedReset {
  readonly key: string;
  readonly label: string;
  readonly availableCount: number;
  /** Epoch millis, soonest first; shorter than `availableCount` when some never expire. */
  readonly expiries: readonly number[];
  readonly input: ProviderConsumeResetCreditInput;
  readonly windowId: string | undefined;
}

export const RESET_EXPIRY_SOON_MS = 7 * DAY;

export function bankedResets(account: LimitAccount): ReadonlyArray<BankedReset> {
  const credits = account.limits.resetCredits;
  if (!account.redeem || !credits?.availableCount) return [];
  const { input } = account.redeem;
  const windows = account.limits.windows;
  // Resets that don't say what they refill sit on the weekly window, else the longest one.
  const fallback = (
    windows.find((window) => window.kind === "weekly") ??
    [...windows].sort(
      (left, right) => WINDOW_KIND_ORDER[right.kind] - WINDOW_KIND_ORDER[left.kind],
    )[0]
  )?.id;
  const placed = (refills: ReadonlyArray<string> | undefined) =>
    refills?.find((id) => windows.some((window) => window.id === id)) ?? fallback;
  const times = (expiries: ReadonlyArray<string> | undefined, soonest: string | undefined) =>
    (expiries ?? (soonest ? [soonest] : []))
      .map((at) => Date.parse(at))
      .filter(Number.isFinite)
      .sort((left, right) => left - right);
  if (!credits.options) {
    return [
      {
        key: "next",
        label: "Reset",
        availableCount: credits.availableCount,
        expiries: times(credits.expiries, credits.nextExpiresAt),
        input,
        windowId: fallback,
      },
    ];
  }
  return credits.options
    .filter((option) => option.availableCount > 0)
    .map((option) => ({
      key: option.creditId,
      label: option.label,
      availableCount: option.availableCount,
      expiries: times(option.expiries, option.expiresAt),
      input: { ...input, creditId: option.creditId },
      windowId: placed(option.refills),
    }));
}

/** Compact time to a reset's expiry: whole days, then hours, then minutes. */
export function formatExpiresIn(ms: number): string {
  const remaining = Math.max(0, ms);
  if (remaining >= DAY) return `${Math.floor(remaining / DAY)}d`;
  if (remaining >= HOUR) return `${Math.floor(remaining / HOUR)}h`;
  return `${Math.max(1, Math.floor(remaining / MINUTE))}m`;
}

/** A reset's expiry date, such as "Sat, Nov 21", with the year when it isn't this year's. */
export function formatExpiryDate(ms: number, now: number): string {
  const year = new Intl.DateTimeFormat(undefined, { year: "numeric" });
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    ...(year.format(ms) === year.format(now) ? {} : { year: "numeric" }),
  }).format(ms);
}

export type ResetCountdown =
  | { readonly kind: "now" }
  | { readonly kind: "momentarily" }
  | { readonly kind: "in"; readonly ms: number };

export function resetCountdown(
  window: ServerProviderUsageWindow,
  now: number,
): ResetCountdown | null {
  const resetsAt = resetMillis(window);
  if (resetsAt === null) return null;
  if (resetsAt <= now) return { kind: "now" };
  if (resetsAt - now < MINUTE) return { kind: "momentarily" };
  return { kind: "in", ms: resetsAt - now };
}

export const USAGE_LIMITS_COMMAND = {
  name: "usage-limits",
  description: "Show this provider's usage limits",
} satisfies ServerProviderSlashCommand;

export function isUsageLimitsCommand(prompt: string): boolean {
  return prompt.trim().toLowerCase() === "/usage-limits";
}

export function hasProviderUsageLimits(
  driver: ServerProvider["driver"],
  providers: readonly ServerProvider[],
  sources: UsageLimitSourceSnapshots,
): boolean {
  return (
    providersWithLimits(providers).some((provider) => provider.driver === driver) ||
    sources.some(
      (source) =>
        source.accounts.some((account) => account.driver === driver) ||
        (source.error !== undefined && source.accounts.length === 0),
    )
  );
}

export function sameUsageLimitCommandCoverage(
  previous: UsageLimitSourceSnapshots,
  next: UsageLimitSourceSnapshots,
): boolean {
  const coverage = (sources: UsageLimitSourceSnapshots) =>
    new Set(
      sources.flatMap((source) =>
        source.error !== undefined && source.accounts.length === 0
          ? ["*"]
          : source.accounts.map((account) => String(account.driver)),
      ),
    );
  const before = coverage(previous);
  const after = coverage(next);
  return before.size === after.size && [...before].every((driver) => after.has(driver));
}

/** Advertise on workspace catalogs too, which replace the global command list. */
export function withUsageLimitsCommands(
  providers: readonly ServerProvider[],
  sources: UsageLimitSourceSnapshots,
): ServerProvider[] {
  const supportedDrivers = new Set([
    ...providersWithLimits(providers).map((provider) => provider.driver),
    ...sources.flatMap((source) => source.accounts.map((account) => account.driver)),
  ]);
  const unreadableSource = sources.some(
    (source) => source.error !== undefined && source.accounts.length === 0,
  );
  return providers.map((provider) => {
    if (!unreadableSource && !supportedDrivers.has(provider.driver)) return provider;
    const commands = (items: readonly ServerProviderSlashCommand[]) => [
      ...items.filter((command) => command.name !== USAGE_LIMITS_COMMAND.name),
      USAGE_LIMITS_COMMAND,
    ];
    return {
      ...provider,
      slashCommands: commands(provider.slashCommands),
      ...(provider.workspaceSnapshots
        ? {
            workspaceSnapshots: provider.workspaceSnapshots.map((snapshot) => ({
              ...snapshot,
              slashCommands: commands(snapshot.slashCommands),
            })),
          }
        : {}),
    };
  });
}

/** The hubs an instance sends its requests through: those whose address is its endpoint. */
export function instanceHubs(
  provider: ServerProvider,
  sources: UsageLimitSourceSnapshots,
): UsageLimitSourceSnapshots {
  const endpoint = provider.auth.endpoint;
  return endpoint === undefined ? [] : sources.filter((source) => source.origin === endpoint);
}

/** The hub accounts that serve a model: those that list it, else every account of the driver. */
export function hubRoutes(
  sources: UsageLimitSourceSnapshots,
  driver: ServerProvider["driver"],
  model: string | null,
): (account: UsageLimitSourceAccount) => boolean {
  // Claude Code's 1M-context suffix is not part of the model id a hub routes.
  const full = model?.replace(/\[1m\]$/i, "");
  // The hub routes a thinking suffix such as "gpt-5.2(high)" by its base model when one lists it.
  const base = full?.replace(/\([^)]*\)$/, "");
  const lists = (id: string | undefined) =>
    sources.some((source) => source.accounts.some((account) => account.models?.includes(id ?? "")));
  const slug = lists(base) ? base : full;
  const listed = (account: UsageLimitSourceAccount) =>
    slug !== undefined && account.models?.includes(slug) === true;
  const serving = new Set(
    sources.flatMap((source) => source.accounts.filter(listed).map((account) => account.driver)),
  );
  // A switched-off login routes nothing.
  // Model ids such as "opus" are aliases no hub lists, so no listing falls back to the driver.
  if (serving.size === 0)
    return (account) =>
      account.disabled !== true && account.driver === driver && account.models?.length !== 0;
  // An account whose model list was unreadable may serve the model too.
  return (account) =>
    account.disabled !== true &&
    (account.models ? listed(account) : serving.has(account.driver) || account.driver === driver);
}

export function collectProviderUsageLimits(
  instanceId: ProviderInstanceId,
  providers: readonly ServerProvider[],
  sources: UsageLimitSourceSnapshots,
  now: number,
  model: string | null = null,
): UsageLimitsReport | null {
  const selected = providers.find((provider) => provider.instanceId === instanceId);
  if (!selected) return null;
  // Only an instance sent to a hub is known to reach the accounts that hub routes its model to.
  const hubs = instanceHubs(selected, sources);
  const routes =
    hubs.length > 0
      ? hubRoutes(hubs, selected.driver, model)
      : (account: UsageLimitSourceAccount) => account.driver === selected.driver;
  const shownHubs = hubs.length > 0 ? hubs : sources;
  const drivers = new Set(
    shownHubs.flatMap((source) => source.accounts.filter(routes).map((account) => account.driver)),
  );
  if (drivers.size === 0) drivers.add(selected.driver);
  if (![...drivers].some((driver) => hasProviderUsageLimits(driver, providers, sources))) {
    return null;
  }
  const resolveKey = accountKeyResolver([
    ...providers.filter((provider) => provider.enabled).map(nativeReport),
    ...sources.flatMap((source) => source.accounts),
  ]);
  // Behind a hub, a local login counts only when it is one of the accounts the hub routes to.
  const routedKeys =
    hubs.length > 0
      ? new Set(hubs.flatMap((source) => source.accounts.filter(routes).map(resolveKey)))
      : null;
  type NativeSnapshot = { provider: ServerProvider; limits: ServerProviderUsageLimits };
  const nativeByAccount = new Map<
    string,
    { usage: NativeSnapshot; credits: NativeSnapshot | null }
  >();
  for (const provider of providersWithLimits(providers)) {
    if (!drivers.has(provider.driver) || !provider.usageLimits) continue;
    const accountKey = resolveKey(nativeReport(provider));
    if (routedKeys && (accountKey === null || !routedKeys.has(accountKey))) continue;
    const snapshot = { provider, limits: provider.usageLimits };
    const key = accountKey ?? `instance:${provider.instanceId}`;
    const previous = nativeByAccount.get(key);
    const previousUsable = previous ? limitsNotice(previous.usage.limits) === null : false;
    const usable = limitsNotice(snapshot.limits) === null;
    const providerWins =
      !previous ||
      (usable && !previousUsable) ||
      (usable === previousUsable &&
        Date.parse(snapshot.limits.checkedAt) > Date.parse(previous.usage.limits.checkedAt));
    const previousCredit = previous?.credits;
    const credits =
      snapshot.limits.resetCredits &&
      (!previousCredit ||
        Date.parse(snapshot.limits.checkedAt) > Date.parse(previousCredit.limits.checkedAt))
        ? snapshot
        : (previousCredit ?? null);
    nativeByAccount.set(key, {
      usage: providerWins ? snapshot : previous.usage,
      credits,
    });
  }
  const native = [...nativeByAccount.values()];
  const nativeAccountKeys = new Set(
    native.flatMap(({ usage: { provider, limits } }) => {
      const key = resolveKey(nativeReport(provider));
      return key && limits.windows.length && !limits.unavailable ? [key] : [];
    }),
  );
  const accounts: Array<UsageLimitsReport["accounts"][number]> = [];
  const notices: string[] = [];
  for (const {
    usage: { provider, limits },
    credits,
  } of native) {
    const key = resolveKey(nativeReport(provider));
    // Only a hub this instance reaches may redeem a credit for its thread.
    const hubCredits = shownHubs
      .flatMap((source) => source.accounts.map((account) => ({ source, account })))
      .filter(
        ({ account }) =>
          key !== null &&
          resolveKey(account) === key &&
          account.usageLimits.resetCredits &&
          !limitsNotice(account.usageLimits),
      )
      .sort(
        (a, b) =>
          Date.parse(b.account.usageLimits.checkedAt) - Date.parse(a.account.usageLimits.checkedAt),
      )[0];
    const hubCreditId = hubCredits?.account.usageLimits.resetCredits?.nextCreditId;
    const showHubCredits =
      hubCredits &&
      (!credits ||
        Date.parse(hubCredits.account.usageLimits.checkedAt) >
          Date.parse(credits.limits.checkedAt));
    const shownCredits = showHubCredits
      ? hubCredits.account.usageLimits.resetCredits
      : credits?.limits.resetCredits;
    accounts.push({
      id: provider.instanceId,
      driver: provider.driver,
      label: `${provider.displayName?.trim() || String(provider.driver)} [${provider.instanceId}]`,
      ...(provider.auth.label ? { plan: provider.auth.label } : {}),
      instanceId: provider.instanceId,
      resetCreditInput:
        hubCreditId && hubCredits
          ? {
              sourceId: hubCredits.source.id,
              accountId: hubCredits.account.id,
              creditId: hubCreditId,
            }
          : { instanceId: credits?.provider.instanceId ?? provider.instanceId },
      ...(provider.displayName ? { displayName: provider.displayName } : {}),
      ...(provider.accentColor ? { accentColor: provider.accentColor } : {}),
      ...(provider.auth.email ? { email: provider.auth.email } : {}),
      limits: shownCredits ? { ...limits, resetCredits: shownCredits } : limits,
    });
  }
  for (const source of shownHubs) {
    const matching = source.accounts.filter(routes);
    for (const account of matching) {
      const key = resolveKey(account);
      if (key && nativeAccountKeys.has(key)) continue;
      accounts.push({
        id: `${source.id}:${account.id}`,
        driver: account.driver,
        label: `${source.label} · ${hubAccountName(account)}`,
        sourceLabel: "CLI Proxy",
        ...(account.name ? { displayName: account.name } : {}),
        ...(account.usageLimits.resetCredits?.nextCreditId
          ? {
              resetCreditInput: {
                sourceId: source.id,
                accountId: account.id,
                creditId: account.usageLimits.resetCredits.nextCreditId,
              },
            }
          : {}),
        ...(account.plan ? { plan: account.plan } : {}),
        ...(account.email ? { email: account.email } : {}),
        limits: account.usageLimits,
      });
    }
    if (source.error && (matching.length > 0 || source.accounts.length === 0)) {
      notices.push(`${source.label}: ${source.error}`);
    }
  }
  return { createdAt: DateTime.formatIso(DateTime.makeUnsafe(now)), accounts, notices };
}
