import { useAtomValue } from "@effect/atom-react";
import type { MenuAction } from "@react-native-menu/menu";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { EnvironmentId, type UsageProviderKind } from "@t3tools/contracts";
import { providerClients } from "@t3tools/client-runtime/provider-clients";
import { normalizeProviderAccentColor } from "@t3tools/client-runtime/state/provider-instance-display";
import {
  hubLimitPools,
  moveProvider,
  NO_PENDING_HUB_CHANGES,
  type PendingHubChanges,
  routeByResetHubs,
} from "@t3tools/client-runtime/usage-limit-controls";
import { limitRunway } from "@t3tools/shared/usageLimitRunway";
import {
  bankedResets,
  collectLimitAccounts,
  collectLimitPools,
  displayLimitWindows,
  paceRemainingPercent,
  remainingPercent,
  type LimitAccount,
  type LimitPool,
  type LimitPoolMember,
  type LimitPoolWindow,
  staleLimitAccounts,
} from "@t3tools/shared/usageLimits";
import {
  collectExternalUsageLinks,
  collectLimitNotices,
  cursorUsageWindowDetails,
  formatDuration,
} from "@t3tools/shared/usageLimitsCopy";
import { type ReactNode, useState } from "react";
import { Pressable, View } from "react-native";
import { useNowMinuteMs } from "../../lib/clock";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { ControlPill } from "../../components/ui/ControlPill";
import { Menu } from "../../components/ui/Menu";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { ProviderIcon } from "../../components/ProviderIcon";
import { cn } from "../../lib/cn";
import { environmentPresentations } from "../../state/presentation";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { AccountChip, emailInitials } from "./AccountChip";
import { BankedResetButton } from "./BankedResets";
import { PoolFigures, RunwayChart } from "./UsageLimitRunway";
import { ResetCredits } from "./UsageLimitsSection";
import { hubPermissionsAtom, useUsageLimitsLayout } from "./usageLimitsLayout";
import { environmentIdsKey } from "./usageLimitsRefresh";
import { PROVIDER_LABEL, usageProviderKind, useProviderColors } from "./usageProviders";

function accountName(account: LimitAccount) {
  if (account.displayName) return account.displayName;
  if (!account.email) return providerClients.get(account.driver)?.label ?? account.driver;
  return emailInitials(account.email) || "Account";
}

function providerLabel(driver: LimitPool["driver"]) {
  return providerClients.get(driver)?.label ?? driver;
}

// Same gap-and-tick as the Limits rows: two clipped copies of the bar leave a see-through gap.
function PaceGap({
  timeLeft,
  children,
}: {
  readonly timeLeft: number | null;
  readonly children: ReactNode;
}) {
  const [width, setWidth] = useState(0);
  const tickX =
    timeLeft === null || width < 6
      ? null
      : Math.min(Math.max((width * timeLeft) / 100, 3), width - 3);
  return (
    <View
      pointerEvents="none"
      className="absolute inset-0"
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
    >
      {tickX === null
        ? children
        : (
            [
              [0, tickX - 3],
              [tickX + 3, width],
            ] as const
          ).map(([start, end]) => (
            <View
              key={start}
              className="absolute top-0 bottom-0 overflow-hidden"
              style={{ left: start, width: end - start }}
            >
              <View className="absolute top-0 bottom-0" style={{ left: -start, width }}>
                {children}
              </View>
            </View>
          ))}
      {tickX !== null ? (
        <View
          className="absolute top-0 bottom-0 w-px rounded-full bg-foreground opacity-60"
          style={{ left: tickX }}
        />
      ) : null}
    </View>
  );
}

/** One account's own reading under the pooled figure; switched-off logins are dimmed and left out of it. */
function AccountRow({
  member: { account, window },
  weighted,
  color,
  now,
  off,
  onPress,
}: {
  readonly member: Pick<LimitPoolMember, "account" | "window">;
  readonly weighted: boolean;
  readonly color: string;
  readonly now: number;
  readonly off: boolean;
  readonly onPress: () => void;
}) {
  const name = accountName(account);
  const remaining = remainingPercent(window);
  const timeLeft = paceRemainingPercent(window, now);
  const resetsAt = window.resetsAt ? Date.parse(window.resetsAt) : Number.NaN;
  const resetsIn = resetsAt > now ? `in ${formatDuration(resetsAt - now)}` : null;
  const showChip = account.image !== undefined || (account.email && account.displayName);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${name}${off ? ", off" : ""}, ${remaining}% left${resetsIn ? `, resets ${resetsIn}` : ""}`}
      accessibilityHint="Show account details"
      onPress={onPress}
      className={cn("min-h-11 justify-center gap-1 py-1 active:opacity-60", off && "opacity-45")}
    >
      <View className="flex-row items-center gap-1.5">
        {showChip ? <AccountChip email={account.email} image={account.image} /> : null}
        <Text numberOfLines={1} className="min-w-0 shrink text-xs text-foreground-muted">
          {name}
        </Text>
        {weighted && account.capacity !== 1 ? (
          <Text className="text-xs text-foreground-tertiary">×{account.capacity}</Text>
        ) : null}
        {off ? <Text className="text-xs text-foreground-muted">· off</Text> : null}
        <View className="flex-1" />
        <Text className="text-xs font-t3-medium tabular-nums text-foreground">{remaining}%</Text>
        {resetsIn ? (
          <Text className="text-xs tabular-nums text-foreground-tertiary">{resetsIn}</Text>
        ) : null}
        {memberResets([{ account, window }]).map(({ reset, environmentId }) => (
          <BankedResetButton
            key={reset.key}
            reset={reset}
            environmentId={environmentId}
            accountName={name}
            now={now}
          />
        ))}
      </View>
      <View className="h-2">
        <PaceGap timeLeft={timeLeft}>
          <View className="absolute inset-x-0 top-0.5 bottom-0.5 rounded-full bg-subtle" />
          {remaining > 0 ? (
            <View
              className="absolute top-0.5 bottom-0.5 left-0 rounded-full"
              style={{
                width: `${remaining}%`,
                backgroundColor: normalizeProviderAccentColor(account.accentColor) ?? color,
                opacity: 0.8,
              }}
            />
          ) : null}
        </PaceGap>
      </View>
    </Pressable>
  );
}

/** Each account's banked resets that refill mainly its window here. */
function memberResets(members: ReadonlyArray<Pick<LimitPoolMember, "account" | "window">>) {
  return members.flatMap(({ account, window }) => {
    const redeem = account.redeem;
    return redeem
      ? bankedResets(account)
          .filter((reset) => reset.windowId === window.id)
          .map((reset) => ({ reset, account, environmentId: redeem.environmentId }))
      : [];
  });
}

function PoolWindowCard({
  pool,
  color,
  now,
  label,
  description,
  showAccounts,
  onOpenAccount,
  wide,
}: {
  readonly pool: LimitPoolWindow;
  readonly color: string;
  readonly now: number;
  readonly label: string | null;
  readonly description?: string | undefined;
  readonly showAccounts: boolean;
  readonly onOpenAccount: (account: LimitAccount) => void;
  readonly wide: boolean;
}) {
  const runway = limitRunway(pool, now);
  // Plan sizes only weigh the pool when every account's is known.
  const weighted = pool.members.every((member) => member.account.capacity !== undefined);
  const figures = <PoolFigures pool={pool} runway={runway} label={label} now={now} />;
  const resets = memberResets([...pool.members, ...pool.offMembers]);
  const chart = runway ? (
    <RunwayChart runway={runway} color={color} now={now} label={label ?? pool.label} />
  ) : null;
  return (
    <View className="gap-3 rounded-[24px] border-continuous bg-grouped-card p-4">
      {wide ? (
        <View className="flex-row items-center gap-6">
          <View className="w-44">{figures}</View>
          <View className="min-w-0 flex-1">{chart}</View>
        </View>
      ) : (
        <>
          {figures}
          {chart}
        </>
      )}
      {description ? <Text className="text-xs text-foreground-muted">{description}</Text> : null}
      {showAccounts ? (
        <View className="border-t border-border-subtle pt-2">
          {resets.length > 0 ? (
            <Text className="self-end px-2 text-[11px] text-foreground-tertiary">Banked</Text>
          ) : null}
          {pool.members.map((member) => (
            <AccountRow
              key={member.account.key}
              member={member}
              weighted={weighted}
              color={color}
              now={now}
              off={false}
              onPress={() => onOpenAccount(member.account)}
            />
          ))}
          {pool.offMembers.map((member) => (
            <AccountRow
              key={member.account.key}
              member={member}
              weighted={weighted}
              color={color}
              now={now}
              off
              onPress={() => onOpenAccount(member.account)}
            />
          ))}
        </View>
      ) : resets.length > 0 ? (
        <View className="flex-row flex-wrap items-center gap-1.5 border-t border-border-subtle pt-3">
          <Text className="mr-1 text-[11px] text-foreground-tertiary">Banked</Text>
          {resets.map(({ reset, account, environmentId }) => (
            <BankedResetButton
              key={`${account.key}:${reset.key}`}
              reset={reset}
              environmentId={environmentId}
              accountName={accountName(account)}
              chip={{ email: account.email, image: account.image }}
              now={now}
            />
          ))}
        </View>
      ) : null}
    </View>
  );
}

/** Pools keep a login's earlier reading when the hub's last read of it failed; old ones are noted. */
function StaleReadings({ pool, now }: { readonly pool: LimitPool; readonly now: number }) {
  const stale = staleLimitAccounts(pool.accounts, now);
  if (stale.length === 0) return null;
  return (
    <View className="gap-1 px-1">
      {stale.map((account) => (
        <Text key={account.key} className="text-xs text-foreground-muted">
          <Text className="text-xs font-t3-medium text-foreground">{accountName(account)}</Text>{" "}
          couldn't be read just now; showing its reading from{" "}
          {formatDuration(Math.max(0, now - Date.parse(account.limits.checkedAt)))} ago.
        </Text>
      ))}
    </View>
  );
}

const limitKey = (pool: LimitPool, window: LimitPoolWindow) => `${pool.driver}:${window.id}`;

function windowLabel(pool: LimitPool, window: LimitPoolWindow) {
  return (
    (pool.driver === "cursor" ? cursorUsageWindowDetails(window.id, pool)?.label : undefined) ??
    window.label
  );
}

export function UsageLimitsSection({
  now,
  failedLabels,
  selectedEnvironmentIds,
  wide = false,
}: {
  readonly now: number;
  readonly failedLabels: readonly string[];
  readonly selectedEnvironmentIds: ReadonlySet<EnvironmentId> | null;
  readonly wide?: boolean;
}) {
  const navigation = useNavigation();
  const presentations = useAtomValue(environmentPresentations.presentationsWithProvidersAtom);
  const layout = useUsageLimitsLayout();
  const { providerOrder, hiddenProviders, hiddenLimits, hiddenAccountRows } = layout;
  const selected =
    selectedEnvironmentIds === null
      ? presentations
      : new Map([...presentations].filter(([id]) => selectedEnvironmentIds.has(id)));
  const [pending, setPending] = useState<PendingHubChanges>(NO_PENDING_HUB_CHANGES);
  const resolved = hubLimitPools(selected, pending, now);
  // Dropped during render once the hub reports a change, or the login is gone.
  if (resolved.pending !== pending) setPending(resolved.pending);
  const rank = (pool: LimitPool) => {
    const provider = usageProviderKind(pool.driver);
    return provider ? providerOrder.indexOf(provider) : providerOrder.length;
  };
  const pools = resolved.pools
    .filter((pool) => {
      const provider = usageProviderKind(pool.driver);
      return provider === null || !hiddenProviders.has(provider);
    })
    .sort((left, right) => rank(left) - rank(right));
  const environmentIds = [...selected.keys()];
  const permissions = useAtomValue(hubPermissionsAtom(environmentIdsKey(environmentIds)));
  const mayRoute = (account: LimitAccount) =>
    account.routing !== null && permissions.route.has(account.routing.environmentId);
  const setRouteByReset = useAtomCommand(
    serverEnvironment.setUsageLimitSourceRouteByReset,
    "Change hub routing",
  );
  const toggleRouteByReset = (pool: LimitPool) => {
    const routable = routeByResetHubs(pool, mayRoute);
    if (routable === null) return;
    const enabled = !routable.on;
    for (const [key, routing] of routable.hubs) {
      setPending((previous) => ({
        ...previous,
        byReset: new Map([...previous.byReset, [key, enabled]]),
      }));
      void setRouteByReset({
        environmentId: routing.environmentId,
        input: { sourceId: routing.sourceId, driver: pool.driver, enabled },
      }).then((result) => {
        if (result._tag === "Failure") {
          setPending((previous) => ({
            ...previous,
            byReset: new Map([...previous.byReset].filter(([entry]) => entry !== key)),
          }));
        }
      });
    }
  };
  const environmentParam = selectedEnvironmentIds === null ? null : [...selectedEnvironmentIds];
  const openAccount = (pool: LimitPoolWindow) => (account: LimitAccount) =>
    navigation.navigate("SettingsUsageAccount", {
      accountKey: account.key,
      windowId: pool.id,
      windowKind: pool.kind,
      environmentIds: environmentParam,
    });
  const shownProviders = pools.flatMap((pool) => usageProviderKind(pool.driver) ?? []);
  const menuFor = (pool: LimitPool) => {
    const provider = usageProviderKind(pool.driver);
    if (!provider) return null;
    const label = providerLabel(pool.driver);
    const index = shownProviders.indexOf(provider);
    const limits = displayLimitWindows(pool).map((window) => ({
      key: limitKey(pool, window),
      label: windowLabel(pool, window),
    }));
    const accountsShown = !hiddenAccountRows.has(provider);
    const routeByReset = routeByResetHubs(pool, mayRoute);
    const hasHubControls =
      pool.accounts.some(mayRoute) ||
      resolved.hubLogins.some(
        (login) =>
          login.driver === pool.driver &&
          (permissions.disable.has(login.environmentId) ||
            permissions.rename.has(login.environmentId)),
      );
    const actions: MenuAction[] = [
      {
        id: "up",
        title: "Move up",
        image: "arrow.up",
        attributes: { disabled: index <= 0 },
      },
      {
        id: "down",
        title: "Move down",
        image: "arrow.down",
        attributes: { disabled: index === -1 || index >= shownProviders.length - 1 },
      },
      ...(limits.length > 1
        ? [
            {
              id: "limits",
              title: "Limits",
              image: "list.number",
              subactions: limits.map((limit): MenuAction => ({
                id: `limit:${limit.key}`,
                title: limit.label,
                state: hiddenLimits.has(limit.key) ? "off" : "on",
              })),
            } satisfies MenuAction,
          ]
        : []),
      ...(pool.accounts.length > 1
        ? [
            {
              id: "accounts",
              title: "Show accounts",
              state: accountsShown ? "on" : "off",
            } satisfies MenuAction,
          ]
        : []),
      ...(routeByReset
        ? [
            {
              id: "route-by-reset",
              title: "Route by earliest reset",
              state: routeByReset.on ? "on" : "off",
            } satisfies MenuAction,
          ]
        : []),
      ...(hasHubControls
        ? [{ id: "hub", title: "Hub accounts", image: "person.2" } satisfies MenuAction]
        : []),
      { id: "hide", title: `Hide ${label}`, image: "eye.slash" },
    ];
    const onAction = (id: string) => {
      if (id === "up" || id === "down") {
        layout.update({
          providerOrder: moveProvider(
            providerOrder,
            shownProviders,
            provider,
            id === "up" ? -1 : 1,
          ),
        });
      } else if (id.startsWith("limit:")) {
        const key = id.slice("limit:".length);
        layout.update({
          hiddenLimits: hiddenLimits.has(key)
            ? [...hiddenLimits].filter((entry) => entry !== key)
            : [...hiddenLimits, key],
        });
      } else if (id === "accounts") {
        layout.update({
          hiddenAccountRows: accountsShown
            ? [...hiddenAccountRows, provider]
            : [...hiddenAccountRows].filter((entry) => entry !== provider),
        });
      } else if (id === "route-by-reset") {
        toggleRouteByReset(pool);
      } else if (id === "hub") {
        navigation.navigate("SettingsUsageHub", {
          driver: pool.driver,
          environmentIds: environmentParam,
        });
      } else if (id === "hide") {
        layout.update({ hiddenProviders: [...hiddenProviders, provider] });
      }
    };
    return (
      <Menu
        accessible
        accessibilityRole="button"
        accessibilityLabel={`${label} limit actions`}
        title={label}
        actions={actions}
        onPressAction={({ nativeEvent }) => onAction(nativeEvent.event)}
      >
        <ControlPill icon="ellipsis" accessibilityLabel={`${label} limit actions`} />
      </Menu>
    );
  };
  const notices = collectLimitNotices(selected);
  const externalLinks = collectExternalUsageLinks(selected);
  const colors = useProviderColors();
  const hiddenCount = resolved.pools.length - pools.length;
  return (
    <View className="gap-6">
      {pools.length === 0 &&
      notices.length === 0 &&
      failedLabels.length === 0 &&
      externalLinks.length === 0 ? (
        <Text className="py-12 text-center text-base text-foreground-muted">
          {selected.size === 0
            ? "Select an environment to see limits."
            : hiddenCount > 0
              ? "Every provider with limits is hidden. Show one from the provider filter."
              : "No provider on the selected environments reports subscription limits."}
        </Text>
      ) : null}
      {pools.map((pool) => {
        const provider = usageProviderKind(pool.driver);
        const windows = displayLimitWindows(pool).filter(
          (window) => !hiddenLimits.has(limitKey(pool, window)),
        );
        const showAccounts =
          pool.accounts.length > 1 && (provider === null || !hiddenAccountRows.has(provider));
        const allOff = resolved.hubLogins.every(
          (login) => login.driver !== pool.driver || login.disabled,
        );
        return (
          <View key={pool.driver} className="gap-3">
            <View className="flex-row items-center gap-2 px-1">
              <ProviderIcon provider={pool.driver} size={18} />
              <Text className="flex-1 text-base font-t3-medium text-foreground">
                {providerLabel(pool.driver)}
              </Text>
              {menuFor(pool)}
            </View>
            {windows.map((window) => {
              const details =
                pool.driver === "cursor" ? cursorUsageWindowDetails(window.id, pool) : undefined;
              return (
                <PoolWindowCard
                  key={`${window.kind}:${window.id}`}
                  pool={window}
                  color={colors[provider ?? "codex"]}
                  now={now}
                  label={details ? details.label : window.label}
                  description={details?.description}
                  showAccounts={showAccounts}
                  onOpenAccount={openAccount(window)}
                  wide={wide}
                />
              );
            })}
            {pool.windows.length === 0 && allOff ? (
              <Text className="px-1 text-sm text-foreground-muted">Every hub account is off.</Text>
            ) : null}
            <StaleReadings pool={pool} now={now} />
          </View>
        );
      })}
      {externalLinks.map((link) => (
        <View key={link.url} className="gap-3 rounded-xl border border-border-subtle p-4">
          <Text className="text-base font-t3-medium text-foreground">{link.label}</Text>
          <Text className="text-xs text-foreground-muted">{link.accounts.join(", ")}</Text>
          {link.message ? (
            <Text className="text-sm text-foreground-muted">{link.message}</Text>
          ) : null}
          <Pressable
            accessibilityRole="link"
            className="min-h-11 justify-center"
            onPress={() => void tryOpenExternalUrl(link.url)}
          >
            <Text className="text-sm font-t3-medium text-primary">Manage usage</Text>
          </Pressable>
        </View>
      ))}
      {notices.length > 0 || failedLabels.length > 0 ? (
        <View
          accessible
          accessibilityRole="alert"
          accessibilityLiveRegion="polite"
          className="flex-row items-start gap-2 rounded-xl border border-warning-border bg-warning px-3.5 py-3"
        >
          <SymbolView
            name="exclamationmark.triangle"
            size={16}
            tintColorClassName="accent-warning-foreground"
          />
          <View className="min-w-0 flex-1 gap-0.5">
            {notices.map((notice) => (
              <Text key={notice} className="text-sm font-t3-medium text-warning-foreground">
                {notice}
              </Text>
            ))}
            {failedLabels.length > 0 ? (
              <Text className="text-sm font-t3-medium text-warning-foreground">
                {failedLabels.join(", ")} could not refresh limits. Showing the last known values.
              </Text>
            ) : null}
          </View>
        </View>
      ) : null}
    </View>
  );
}

/** The header filter that hides providers from the Limits view and shows them again. */
export function useUsageLimitsProviderMenu() {
  const layout = useUsageLimitsLayout();
  const { providerOrder, hiddenProviders } = layout;
  return {
    title: "Filter limit providers",
    icon: "slider.horizontal.3" as const,
    items: [
      {
        id: "all-providers",
        title: "All providers",
        selected: hiddenProviders.size === 0,
        onPress: () => layout.update({ hiddenProviders: [] }),
      },
      ...providerOrder.map((provider: UsageProviderKind) => ({
        id: `provider:${provider}`,
        title: PROVIDER_LABEL[provider],
        selected: !hiddenProviders.has(provider),
        onPress: () =>
          layout.update({
            hiddenProviders: hiddenProviders.has(provider)
              ? [...hiddenProviders].filter((entry) => entry !== provider)
              : [...hiddenProviders, provider],
          }),
      })),
    ],
  };
}

type AccountScreenProps = StaticScreenProps<{
  accountKey: string;
  windowId: string;
  windowKind: LimitPoolWindow["kind"];
  environmentIds: readonly string[] | null;
}>;

export function UsageLimitAccountScreen({ route }: AccountScreenProps) {
  const insets = useSafeAreaInsets();
  const presentations = useAtomValue(environmentPresentations.presentationsWithProvidersAtom);
  const { accountKey, windowId, windowKind, environmentIds } = route.params;
  const now = useNowMinuteMs();
  const selectedIds =
    environmentIds === null ? null : new Set(environmentIds.map((id) => EnvironmentId.make(id)));
  const selected =
    selectedIds === null
      ? presentations
      : new Map([...presentations].filter(([id]) => selectedIds.has(id)));
  const accounts = collectLimitAccounts(selected);
  const account = accounts.find((candidate) => candidate.key === accountKey);
  const pool = collectLimitPools(accounts, now)
    .find((candidate) => candidate.driver === account?.driver)
    ?.windows.find((candidate) => candidate.id === windowId && candidate.kind === windowKind);
  const poolMembers = pool ? [...pool.members, ...pool.offMembers] : [];
  const member = poolMembers.find((candidate) => candidate.account.key === accountKey);
  const window = member?.window;
  const evenPace = window ? paceRemainingPercent(window, now) : null;
  const reset = pool?.resets.find((candidate) => candidate.member.account.key === accountKey);
  const [revealed, setRevealed] = useState(false);
  return (
    <SettingsScreen title="Account">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="gap-5 p-5"
        contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
      >
        {!account || !window ? (
          <Text className="text-base text-foreground-muted">
            This account is no longer reporting limits on the selected environments.
          </Text>
        ) : (
          <>
            <View className="gap-2">
              <View className="flex-row items-center gap-2">
                <ProviderIcon provider={account.driver} size={24} />
                <Text className="flex-1 text-xl font-t3-bold text-foreground">
                  {account.displayName ?? providerLabel(account.driver)}
                </Text>
              </View>
              {account.email ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={revealed ? "Hide account email" : "Reveal account email"}
                  onPress={() => setRevealed((value) => !value)}
                  className="min-h-[44px] justify-center"
                >
                  <Text className="text-sm text-foreground-muted">
                    {revealed ? account.email : "••••••@••••••"}
                  </Text>
                </Pressable>
              ) : null}
              {account.plan ? (
                <Text selectable className="text-sm text-foreground-muted">
                  {account.plan}
                </Text>
              ) : null}
              {account.disabled ? (
                <Text className="text-sm text-foreground-muted">
                  Switched off in the hub, so the pool leaves it out.
                </Text>
              ) : null}
            </View>
            <View className="gap-3 rounded-[24px] border-continuous bg-grouped-card p-4">
              <Text className="text-sm font-t3-medium text-foreground">{window.label}</Text>
              <Text className="text-3xl font-t3-bold tabular-nums text-foreground">
                {remainingPercent(window)}% left
              </Text>
              {window.resetsAt ? (
                <Text selectable className="text-sm text-foreground-muted">
                  Resets{" "}
                  {new Date(window.resetsAt).toLocaleString(undefined, {
                    dateStyle: "medium",
                    timeStyle: "short",
                  })}
                </Text>
              ) : null}
              {evenPace !== null ? (
                <Text className="text-sm text-foreground-muted">
                  Even pace: {evenPace}% left by now
                </Text>
              ) : null}
              {reset && reset.restoresPercent > 0 ? (
                <Text className="text-sm text-foreground-muted">
                  Restores {reset.restoresPercent}% of the pool
                </Text>
              ) : null}
            </View>
            <View className="gap-2 rounded-[24px] border-continuous bg-grouped-card p-4">
              <Text className="text-sm font-t3-medium text-foreground">
                {account.environments.length ? "Signed in" : "Source"}
              </Text>
              {account.environments.length ? (
                account.environments.map((environment) => (
                  <Text key={environment.environmentId} className="text-sm text-foreground-muted">
                    {environment.label}
                  </Text>
                ))
              ) : (
                <Text className="text-sm text-foreground-muted">{account.sourceLabel}</Text>
              )}
            </View>
            {account.redeem && account.limits.resetCredits ? (
              <View className="gap-3 rounded-[24px] border-continuous bg-grouped-card p-4">
                <Text className="text-sm font-t3-medium text-foreground">Reset credits</Text>
                <ResetCredits
                  key={account.key}
                  environmentId={account.redeem.environmentId}
                  input={account.redeem.input}
                  credits={account.limits.resetCredits}
                  now={now}
                />
              </View>
            ) : null}
          </>
        )}
      </ScrollView>
    </SettingsScreen>
  );
}
