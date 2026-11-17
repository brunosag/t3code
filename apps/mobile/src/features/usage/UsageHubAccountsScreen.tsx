import { useAtomValue } from "@effect/atom-react";
import type { StaticScreenProps } from "@react-navigation/native";
import { providerClients } from "@t3tools/client-runtime/provider-clients";
import {
  hubLimitPools,
  type HubListing,
  listHubs,
  NO_PENDING_HUB_CHANGES,
  type PendingHubChanges,
  pendingRoutingFor,
  reorderedHubAccounts,
  routeByResetHubs,
  withHubLabel,
} from "@t3tools/client-runtime/usage-limit-controls";
import { EnvironmentId, ProviderDriverKind } from "@t3tools/contracts";
import { type LimitAccount, type LimitPool, limitRoutingKey } from "@t3tools/shared/usageLimits";
import { useState } from "react";
import { TextInput, View } from "react-native";
import Reanimated, { ReduceMotion, useAnimatedStyle, withTiming } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { ListToggleRow } from "../../components/ui/ListToggleRow";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { ThemedSwitch } from "../../components/ui/ThemedSwitch";
import { useNowMinuteMs } from "../../lib/clock";
import { cn } from "../../lib/cn";
import { environmentPresentations } from "../../state/presentation";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsDragHandle } from "../settings/components/SettingsDragHandle";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { SettingsSection } from "../settings/components/SettingsSection";
import { AccountChip } from "./AccountChip";
import { hubPermissionsAtom } from "./usageLimitsLayout";
import { environmentIdsKey } from "./usageLimitsRefresh";

type HubScreenProps = StaticScreenProps<{
  driver: string;
  environmentIds: readonly string[] | null;
}>;

const accountLabel = (account: { readonly displayName: string | null; readonly email?: string }) =>
  account.displayName ?? account.email ?? "Account";

/** One provider's hub logins: routing order, earliest-reset routing, which logins are on, hub names. */
export function UsageHubAccountsScreen({ route }: HubScreenProps) {
  const insets = useSafeAreaInsets();
  const now = useNowMinuteMs();
  const presentations = useAtomValue(environmentPresentations.presentationsWithProvidersAtom);
  const { environmentIds } = route.params;
  const driver = ProviderDriverKind.make(route.params.driver);
  const selectedIds =
    environmentIds === null ? null : new Set(environmentIds.map((id) => EnvironmentId.make(id)));
  const selected =
    selectedIds === null
      ? presentations
      : new Map([...presentations].filter(([id]) => selectedIds.has(id)));
  const [pending, setPending] = useState<PendingHubChanges>(NO_PENDING_HUB_CHANGES);
  const resolved = hubLimitPools(selected, pending, now);
  // Dropped during render once the hub reports a change, or the login is gone.
  if (resolved.pending !== pending) setPending(resolved.pending);
  const pool = resolved.pools.find((candidate) => candidate.driver === driver);
  const permissions = useAtomValue(hubPermissionsAtom(environmentIdsKey([...selected.keys()])));
  const mayRoute = (account: LimitAccount) =>
    account.routing !== null && permissions.route.has(account.routing.environmentId);

  const setRouteByReset = useAtomCommand(
    serverEnvironment.setUsageLimitSourceRouteByReset,
    "Change hub routing",
  );
  const setAccountOrder = useAtomCommand(
    serverEnvironment.setUsageLimitSourceAccountOrder,
    "Change hub routing order",
  );
  const setAccountDisabled = useAtomCommand(
    serverEnvironment.setUsageLimitSourceAccountDisabled,
    "Change hub account",
  );
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, "Rename hub");

  const routeByReset = pool ? routeByResetHubs(pool, mayRoute) : null;
  const toggleRouteByReset = (enabled: boolean) => {
    if (!pool || !routeByReset) return;
    for (const [key, routing] of routeByReset.hubs) {
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

  // Each hub's switched-on logins in routing order; a login only trades places within its own hub.
  const routingGroups = new Map<string, LimitAccount[]>();
  for (const account of pool?.accounts ?? []) {
    const hub = limitRoutingKey(account);
    if (hub === null || account.disabled || !mayRoute(account) || account.routing?.byReset) {
      continue;
    }
    routingGroups.set(hub, [...(routingGroups.get(hub) ?? []), account]);
  }
  const reorder = (activePool: LimitPool, activeKey: string, overKey: string) => {
    const accounts = reorderedHubAccounts(activePool.accounts, activeKey, overKey);
    const routing = accounts?.[0]?.routing;
    if (!accounts || !routing) return;
    setPending((previous) => ({
      ...previous,
      routing: pendingRoutingFor(previous.routing, accounts),
    }));
    void setAccountOrder({
      environmentId: routing.environmentId,
      input: {
        sourceId: routing.sourceId,
        driver: activePool.driver,
        accountIds: accounts.flatMap((account) => account.routing?.accountId ?? []),
      },
    }).then((result) => {
      if (result._tag === "Failure") setPending((previous) => ({ ...previous, routing: null }));
    });
  };

  const hubs = listHubs(
    resolved.hubLogins.filter(
      (login) =>
        login.driver === driver &&
        (permissions.disable.has(login.environmentId) ||
          permissions.rename.has(login.environmentId)),
    ),
  );
  const toggleLogin = (login: HubListing["logins"][number]) => {
    const disabled = !login.disabled;
    setPending((previous) => ({
      ...previous,
      disabled: new Map([...previous.disabled, [login.key, disabled]]),
    }));
    void setAccountDisabled({
      environmentId: login.environmentId,
      input: { sourceId: login.sourceId, accountId: login.accountId, disabled },
    }).then((result) => {
      if (result._tag === "Failure") {
        setPending((previous) => ({
          ...previous,
          disabled: new Map([...previous.disabled].filter(([key]) => key !== login.key)),
        }));
      }
    });
  };
  const sourceConfig = (source: HubListing["sources"][number]) =>
    selected.get(source.environmentId)?.serverConfig?.settings.usageLimitSources[source.sourceId];
  // Each machine keeps its own entry for a hub they share, so a rename reaches every one.
  const rename = (hub: HubListing, name: string) => {
    for (const source of hub.sources) {
      const config = sourceConfig(source);
      if (!config || !permissions.rename.has(source.environmentId)) continue;
      void updateSettings({
        environmentId: source.environmentId,
        input: { patch: { usageLimitSources: { [source.sourceId]: withHubLabel(config, name) } } },
      });
    }
  };

  const providerLabel = providerClients.get(driver)?.label ?? driver;
  const empty = routeByReset === null && routingGroups.size === 0 && hubs.length === 0;
  return (
    <SettingsScreen title={`${providerLabel} hub accounts`}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="gap-6 p-5"
        contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
      >
        {empty ? (
          <Text className="text-base text-foreground-muted">
            No hub on the selected environments lets this connection change its {providerLabel}{" "}
            logins.
          </Text>
        ) : null}
        {routeByReset ? (
          <SettingsSection
            title="Routing"
            footer={
              routeByReset.on
                ? "The server keeps logins in order of their longest limit's reset, soonest first."
                : "The hub routes to the highest login in the order below that still has quota."
            }
          >
            <ListToggleRow
              label="Route by earliest reset"
              value={routeByReset.on}
              onValueChange={toggleRouteByReset}
            />
          </SettingsSection>
        ) : null}
        {pool
          ? [...routingGroups].map(([hub, accounts]) =>
              accounts.length > 1 ? (
                <RoutingOrderSection
                  key={hub}
                  title={
                    routingGroups.size > 1
                      ? `Routing order · ${accounts[0]!.sourceLabel ?? "Hub"}`
                      : "Routing order"
                  }
                  accounts={accounts}
                  onMove={(activeKey, overKey) => reorder(pool, activeKey, overKey)}
                />
              ) : null,
            )
          : null}
        {hubs.map((hub) => {
          const config = hub.sources.map(sourceConfig).find((entry) => entry !== undefined);
          const canRename =
            config !== undefined &&
            hub.sources.some((source) => permissions.rename.has(source.environmentId));
          const togglable = hub.logins.filter((login) =>
            permissions.disable.has(login.environmentId),
          );
          return (
            <SettingsSection
              key={hub.sources.map((source) => source.sourceId).join("\n")}
              title={hub.label}
            >
              {canRename ? (
                <HubNameRow
                  key={config.label ?? ""}
                  name={config.label ?? ""}
                  url={config.url}
                  onSave={(name) => rename(hub, name)}
                />
              ) : null}
              {togglable.map((login, index) => {
                const name = login.name ?? login.email ?? login.accountId;
                return (
                  <View
                    key={login.key}
                    className={cn((canRename || index > 0) && "border-t border-border-subtle")}
                  >
                    <ListRowLayout
                      leading={
                        <AccountChip email={login.email ?? login.accountId} image={login.image} />
                      }
                      label={name}
                      description={login.disabled ? "Off · the hub routes nothing here" : undefined}
                      accessory={
                        <ThemedSwitch
                          accessibilityLabel={`Route to ${name}`}
                          value={!login.disabled}
                          onValueChange={() => toggleLogin(login)}
                        />
                      }
                    />
                  </View>
                );
              })}
            </SettingsSection>
          );
        })}
      </ScrollView>
    </SettingsScreen>
  );
}

function HubNameRow({
  name,
  url,
  onSave,
}: {
  readonly name: string;
  readonly url: string;
  readonly onSave: (name: string) => void;
}) {
  const [draft, setDraft] = useState(name);
  const save = () => {
    if (draft.trim() !== name) onSave(draft);
  };
  return (
    <View className="gap-1 px-4 py-3">
      <Text textRole="footnote" className="text-foreground-muted">
        Hub name
      </Text>
      <TextInput
        accessibilityLabel="Hub name"
        className="rounded-lg border border-border-subtle px-3 py-2 text-base text-foreground"
        placeholderTextColorClassName="accent-foreground-muted"
        placeholder={url}
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="done"
        value={draft}
        onChangeText={setDraft}
        onEndEditing={save}
      />
    </View>
  );
}

/** Drag a login, or step it with accessibility actions, to change which login the hub tries first. */
function RoutingOrderSection({
  title,
  accounts,
  onMove,
}: {
  readonly title: string;
  readonly accounts: readonly LimitAccount[];
  readonly onMove: (activeKey: string, overKey: string) => void;
}) {
  const [drag, setDrag] = useState<{ readonly key: string; readonly translation: number } | null>(
    null,
  );
  const [heights, setHeights] = useState<ReadonlyMap<string, number>>(() => new Map());
  // Remount dropped rows so data order and cleared drag offsets change together without flashing.
  const [drops, setDrops] = useState(0);
  const keys = accounts.map((account) => account.key);
  const move = (from: number, to: number) => {
    if (to < 0 || to >= keys.length || from === to) return;
    onMove(keys[from]!, keys[to]!);
  };
  const dropIndex = (from: number, translation: number) => {
    const step = translation > 0 ? 1 : -1;
    let to = from;
    let remaining = Math.abs(translation);
    while (to + step >= 0 && to + step < keys.length) {
      const next = heights.get(keys[to + step]!) ?? 0;
      if (next === 0 || remaining < next / 2) break;
      remaining -= next;
      to += step;
    }
    return to;
  };
  const dragFrom = drag === null ? -1 : keys.indexOf(drag.key);
  const dragTo = drag === null ? -1 : dropIndex(dragFrom, drag.translation);
  const lifted = drag === null ? 0 : (heights.get(drag.key) ?? 0);
  return (
    <SettingsSection
      title={title}
      footer="Top first: the hub routes to the highest login with quota left."
    >
      {accounts.map((account, index) => {
        const shift =
          dragFrom === -1 || index === dragFrom
            ? 0
            : dragFrom < dragTo && index > dragFrom && index <= dragTo
              ? -lifted
              : dragFrom > dragTo && index < dragFrom && index >= dragTo
                ? lifted
                : 0;
        return (
          <RoutingRow
            key={`${account.key}:${drops}`}
            account={account}
            position={index + 1}
            count={accounts.length}
            offset={index === dragFrom ? (drag?.translation ?? 0) : shift}
            lifted={index === dragFrom}
            onHeight={(height) =>
              setHeights((current) =>
                current.get(account.key) === height
                  ? current
                  : new Map(current).set(account.key, height),
              )
            }
            onDragStart={() => setDrag({ key: account.key, translation: 0 })}
            onDragMove={(translation) => setDrag({ key: account.key, translation })}
            onDragEnd={(translation, cancelled) => {
              setDrag(null);
              setDrops((count) => count + 1);
              if (!cancelled) move(index, dropIndex(index, translation));
            }}
            onStep={(direction) => move(index, direction === "up" ? index - 1 : index + 1)}
          />
        );
      })}
    </SettingsSection>
  );
}

function RoutingRow(props: {
  readonly account: LimitAccount;
  readonly position: number;
  readonly count: number;
  readonly offset: number;
  readonly lifted: boolean;
  readonly onHeight: (height: number) => void;
  readonly onDragStart: () => void;
  readonly onDragMove: (translation: number) => void;
  readonly onDragEnd: (translation: number, cancelled: boolean) => void;
  readonly onStep: (direction: "up" | "down") => void;
}) {
  const { account, lifted, offset } = props;
  const name = accountLabel(account);
  const style = useAnimatedStyle(() => ({
    transform: [
      {
        translateY: lifted
          ? offset
          : withTiming(offset, { duration: 160, reduceMotion: ReduceMotion.System }),
      },
    ],
    zIndex: lifted ? 1 : 0,
  }));
  return (
    <Reanimated.View
      style={style}
      onLayout={(event) => props.onHeight(event.nativeEvent.layout.height)}
      className={cn(
        "flex-row items-center gap-3 pl-4",
        props.position > 1 && "border-t border-border-subtle",
        lifted && "bg-grouped-card shadow-md",
      )}
    >
      <View
        accessible
        accessibilityLabel={`${name}, priority ${props.position} of ${props.count}`}
        className="min-h-14 min-w-0 flex-1 flex-row items-center gap-3 py-3"
      >
        <Text className="w-5 text-sm tabular-nums text-foreground-muted">{props.position}</Text>
        <AccountChip email={account.email} image={account.image} />
        <Text numberOfLines={1} className="min-w-0 flex-1 text-base text-foreground">
          {name}
        </Text>
      </View>
      <SettingsDragHandle
        title={name}
        canMoveUp={props.position > 1}
        canMoveDown={props.position < props.count}
        onStart={props.onDragStart}
        onMove={props.onDragMove}
        onEnd={props.onDragEnd}
        onStep={props.onStep}
      />
    </Reanimated.View>
  );
}
