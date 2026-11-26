import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  type CollisionDetection,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { restrictToParentElement, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useAtomValue } from "@effect/atom-react";
import {
  hubLimitPools,
  listHubs,
  moveProvider,
  NO_PENDING_HUB_CHANGES,
  type PendingHubChanges,
  pendingRoutingFor,
  reorderedHubAccounts,
  routeByResetHubs,
  accountRowsShown,
} from "@t3tools/client-runtime/usage-limit-controls";
import {
  type BankedReset,
  bankedResets,
  CHATGPT_USAGE_URL,
  collectHttpQuotaSources,
  collectLimitAccounts,
  displayLimitWindows,
  type HubLogin,
  type LimitAccount,
  type LimitPool,
  type LimitPoolMember,
  type LimitPoolWindow,
  limitRoutingKey,
  remainingPercent,
  staleLimitAccounts,
} from "@t3tools/shared/usageLimits";
import {
  collectExternalUsageLinks,
  collectLimitNotices,
  cursorUsageWindowDetails,
  formatDuration,
  formatResetsIn,
} from "@t3tools/shared/usageLimitsCopy";
import { limitRunway } from "@t3tools/shared/usageLimitRunway";
import type { UsageProviderKind } from "@t3tools/contracts";
import {
  AlertTriangleIcon,
  ArrowDownIcon,
  ArrowUpIcon,
  EllipsisIcon,
  EyeOffIcon,
  ExternalLinkIcon,
  GripVerticalIcon,
  ListChecksIcon,
  UsersIcon,
} from "lucide-react";
import { Fragment, type ReactNode, useState } from "react";

import { ensureLocalApi } from "../../localApi";
import { cn } from "../../lib/utils";
import { environmentAtomList, environmentIdsKey } from "../../state/environmentAtomList";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { providerClients } from "../settings/providerDriverMeta";
import { Button } from "../ui/button";
import { OpenAI } from "../Icons";
import { Alert, AlertTitle } from "../ui/alert";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../ui/menu";
import { AccountChip } from "./AccountChip";
import { BankedResetButton } from "./BankedResets";
import { WindowBar, barColor } from "./UsageLimits";
import { BalanceCard, RunwayCard } from "./UsageLimitRunway";
import { PROVIDER_ORDER, usageProviderForDriver } from "./usageProviders";

const reorderPermissionsAtom = environmentAtomList(
  "web-usage-limit-routing-permissions",
  serverEnvironment.setUsageLimitSourceAccountOrder.permissionAtom,
);

const disablePermissionsAtom = environmentAtomList(
  "web-usage-limit-disable-permissions",
  serverEnvironment.setUsageLimitSourceAccountDisabled.permissionAtom,
);

/** Reorders hub logins; null where the viewer may not change this pool's routing. */
type RoutingReorder = {
  readonly canReorder: (account: LimitAccount) => boolean;
  readonly onReorder: (activeKey: string, overKey: string) => void;
};

function accountName(account: LimitAccount) {
  return (
    account.displayName ??
    account.email ??
    providerClients.get(account.driver)?.label ??
    String(account.driver)
  );
}

function AccountName({
  account,
  className,
}: {
  readonly account: LimitAccount;
  readonly className?: string;
}) {
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1.5", className)}>
      <AccountChip email={account.email} image={account.image} />
      <span className="min-w-0 truncate">{accountName(account)}</span>
    </span>
  );
}

/** Accounts without a reading for this window are left out. */
function AccountRows({
  pool,
  color,
  now,
  routing,
}: {
  readonly pool: LimitPoolWindow;
  readonly color: string;
  readonly now: number;
  readonly routing: RoutingReorder | null;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  // Plan sizes only weigh the pool when every account's is known.
  const weighted = pool.members.every((member) => member.account.capacity !== undefined);
  const movable = routing
    ? pool.members.flatMap(({ account }) => (routing.canReorder(account) ? [account.key] : []))
    : [];
  const hubOf = new Map(
    pool.members.map(({ account }) => [account.key, limitRoutingKey(account)] as const),
  );
  // A login only trades places with others its own hub routes.
  const sameHub: CollisionDetection = (args) =>
    closestCenter({
      ...args,
      droppableContainers: args.droppableContainers.filter(
        (container) => hubOf.get(String(container.id)) === hubOf.get(String(args.active.id)),
      ),
    });
  const sortable = routing !== null && movable.length > 1;
  const banked = memberResets([...pool.members, ...pool.offMembers]).length > 0;
  const grid = (
    <div
      className={cn(
        "grid items-center gap-x-3 md:gap-x-6",
        banked
          ? "grid-cols-[minmax(0,9rem)_minmax(3rem,1fr)_auto_auto] md:grid-cols-[11rem_minmax(0,1fr)_auto_auto]"
          : "grid-cols-[minmax(0,9rem)_minmax(3rem,1fr)_auto] md:grid-cols-[11rem_minmax(0,1fr)_auto]",
      )}
    >
      {banked ? (
        <span className="col-start-4 px-1.5 text-2xs text-muted-foreground/70">Banked</span>
      ) : null}
      {pool.members.map((member) => (
        <AccountRow
          key={member.account.key}
          member={member}
          weighted={weighted}
          color={color}
          now={now}
          grip={sortable ? (movable.includes(member.account.key) ? "handle" : "space") : "none"}
          banked={banked}
        />
      ))}
      {pool.offMembers.map((member) => (
        <AccountRow
          key={member.account.key}
          member={member}
          weighted={weighted}
          color={color}
          now={now}
          grip={sortable ? "space" : "none"}
          banked={banked}
          off
        />
      ))}
    </div>
  );
  if (!sortable) return grid;
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={sameHub}
      modifiers={[restrictToVerticalAxis, restrictToParentElement]}
      onDragEnd={(event) => {
        if (event.over !== null) routing.onReorder(String(event.active.id), String(event.over.id));
      }}
    >
      <SortableContext items={movable} strategy={verticalListSortingStrategy}>
        {grid}
      </SortableContext>
    </DndContext>
  );
}

function AccountRow({
  member: { account, window },
  weighted,
  color,
  now,
  grip,
  banked,
  off = false,
}: {
  readonly member: Pick<LimitPoolMember, "account" | "window">;
  readonly weighted: boolean;
  readonly color: string;
  readonly now: number;
  readonly grip: "handle" | "space" | "none";
  /** Whether the rows have a column for banked resets. */
  readonly banked: boolean;
  readonly off?: boolean;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: account.key, disabled: grip !== "handle" });
  const name = accountName(account);
  const resetsAt = window.resetsAt ? Date.parse(window.resetsAt) : Number.NaN;
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(
        "col-span-full grid grid-cols-subgrid items-center",
        isDragging && "relative z-10 rounded-md bg-background shadow-md",
        off && "opacity-45",
      )}
    >
      <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
        {grip === "handle" ? (
          <button
            type="button"
            ref={setActivatorNodeRef}
            {...attributes}
            {...listeners}
            aria-label={`Drag to change ${name}'s hub routing priority`}
            className="-ms-1 flex size-4 shrink-0 cursor-grab touch-none items-center justify-center rounded text-muted-foreground/60 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset active:cursor-grabbing"
          >
            <GripVerticalIcon className="size-3" />
          </button>
        ) : grip === "space" ? (
          <span aria-hidden className="-ms-1 size-4 shrink-0" />
        ) : null}
        <AccountChip email={account.email} image={account.image} />
        <span className="min-w-0 truncate">{name}</span>
        {weighted && account.capacity !== 1 ? (
          <span className="shrink-0 opacity-60">×{account.capacity}</span>
        ) : null}
        {off ? <span className="shrink-0">· off</span> : null}
        <span className="ms-auto shrink-0 tabular-nums">{remainingPercent(window)}%</span>
      </span>
      <WindowBar thin color={color} window={window} now={now} label={name} />
      <span className="text-end text-xs whitespace-nowrap text-muted-foreground tabular-nums">
        {resetsAt > now ? `in ${formatDuration(resetsAt - now)}` : null}
      </span>
      {banked ? (
        <span className="flex items-center gap-1">
          {memberResets([{ account, window }]).map(({ reset, environmentId }) => (
            <BankedResetButton
              key={reset.key}
              reset={reset}
              environmentId={environmentId}
              accountName={name}
              now={now}
            />
          ))}
        </span>
      ) : null}
    </div>
  );
}

/** The account's banked resets that refill mainly this window. */
function windowResets({
  account,
  window,
}: Pick<LimitPoolMember, "account" | "window">): ReadonlyArray<BankedReset> {
  return bankedResets(account).filter((reset) => reset.windowId === window.id);
}

function memberResets(members: ReadonlyArray<Pick<LimitPoolMember, "account" | "window">>) {
  return members.flatMap((member) => {
    const redeem = member.account.redeem;
    return redeem
      ? windowResets(member).map((reset) => ({
          reset,
          account: member.account,
          environmentId: redeem.environmentId,
        }))
      : [];
  });
}

/** With account rows hidden, the window's banked resets stand on their own, each with its account. */
function WindowBankedResets({
  resets,
  now,
}: {
  readonly resets: ReturnType<typeof memberResets>;
  readonly now: number;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1">
      <span className="me-1 text-2xs text-muted-foreground/70">Banked</span>
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
    </div>
  );
}

function PoolWindowCard({
  pool,
  color,
  now,
  label,
  description,
  showAccounts,
  routing,
}: {
  readonly pool: LimitPoolWindow;
  readonly color: string;
  readonly now: number;
  readonly label: string | null;
  readonly description?: string | undefined;
  readonly showAccounts: boolean;
  readonly routing: RoutingReorder | null;
}) {
  const runway = limitRunway(pool, now);
  const resets = showAccounts ? [] : memberResets([...pool.members, ...pool.offMembers]);
  const accounts = showAccounts ? (
    <AccountRows pool={pool} color={color} now={now} routing={routing} />
  ) : resets.length > 0 ? (
    <WindowBankedResets resets={resets} now={now} />
  ) : null;
  return runway?.paced ? (
    <RunwayCard
      pool={pool}
      runway={runway}
      label={label}
      description={description}
      accounts={accounts}
      color={color}
      now={now}
    />
  ) : (
    <BalanceCard
      pool={pool}
      runway={runway}
      label={label}
      description={description}
      accounts={accounts}
      color={color}
      now={now}
    />
  );
}

/** Pools keep a login's earlier reading when the hub's last read of it failed; old ones are noted. */
function StaleReadings({ pool, now }: { readonly pool: LimitPool; readonly now: number }) {
  const stale = staleLimitAccounts(pool.accounts, now);
  if (stale.length === 0) return null;
  return (
    <div className="flex flex-col gap-1 px-1 text-xs text-muted-foreground">
      {stale.map((account) => (
        <span key={account.key} className="flex flex-wrap items-center gap-x-1.5">
          <AccountName account={account} className="font-medium text-foreground" />
          couldn't be read just now; showing its reading from{" "}
          {formatDuration(Math.max(0, now - Date.parse(account.limits.checkedAt)))} ago.
        </span>
      ))}
    </div>
  );
}

function windowLabel(pool: LimitPool, window: LimitPoolWindow) {
  return (
    (pool.driver === "cursor" ? cursorUsageWindowDetails(window.id, pool)?.label : undefined) ??
    window.label
  );
}

function limitKey(pool: LimitPool, window: LimitPoolWindow) {
  return `${pool.driver}:${window.id}`;
}

function PoolActions({
  label,
  limits,
  accounts,
  routeByReset,
  hubs,
  onMoveUp,
  onMoveDown,
  onHide,
}: {
  readonly label: string;
  readonly limits: ReadonlyArray<{
    readonly key: string;
    readonly label: string;
    readonly shown: boolean;
    readonly onToggle: () => void;
  }>;
  /** Null for a pool of one account. */
  readonly accounts: { readonly shown: boolean; readonly onToggle: () => void };
  /** Null where no hub this viewer manages routes more than one of the provider's logins. */
  readonly routeByReset: { readonly on: boolean; readonly onToggle: () => void } | null;
  /** Each hub's logins for this provider; empty where the viewer may not change them. */
  readonly hubs: ReadonlyArray<{
    readonly label: string;
    readonly logins: ReadonlyArray<{ readonly login: HubLogin; readonly onToggle: () => void }>;
  }>;
  readonly onMoveUp: (() => void) | null;
  readonly onMoveDown: (() => void) | null;
  readonly onHide: () => void;
}) {
  return (
    <Menu>
      <MenuTrigger
        render={<Button aria-label={`${label} limit actions`} size="icon-xs" variant="ghost" />}
      >
        <EllipsisIcon aria-hidden />
      </MenuTrigger>
      <MenuPopup align="end">
        <MenuItem disabled={!onMoveUp} onClick={() => onMoveUp?.()}>
          <ArrowUpIcon aria-hidden />
          Move up
        </MenuItem>
        <MenuItem disabled={!onMoveDown} onClick={() => onMoveDown?.()}>
          <ArrowDownIcon aria-hidden />
          Move down
        </MenuItem>
        <MenuSeparator />
        {limits.length > 1 ? (
          <MenuSub>
            <MenuSubTrigger>
              <ListChecksIcon aria-hidden />
              Limits
            </MenuSubTrigger>
            <MenuSubPopup>
              {limits.map((limit) => (
                <MenuCheckboxItem
                  key={limit.key}
                  checked={limit.shown}
                  closeOnClick={false}
                  onCheckedChange={limit.onToggle}
                >
                  {limit.label}
                </MenuCheckboxItem>
              ))}
            </MenuSubPopup>
          </MenuSub>
        ) : null}
        <MenuCheckboxItem
          checked={accounts.shown}
          closeOnClick={false}
          onCheckedChange={accounts.onToggle}
        >
          Show accounts
        </MenuCheckboxItem>
        {routeByReset ? (
          <MenuCheckboxItem
            checked={routeByReset.on}
            closeOnClick={false}
            onCheckedChange={routeByReset.onToggle}
          >
            Route by earliest reset
          </MenuCheckboxItem>
        ) : null}
        {hubs.length > 0 ? (
          <MenuSub>
            <MenuSubTrigger>
              <UsersIcon aria-hidden />
              Hub accounts
            </MenuSubTrigger>
            <MenuSubPopup>
              {hubs.map((hub) => (
                <MenuGroup key={hub.label}>
                  <MenuGroupLabel>{hub.label}</MenuGroupLabel>
                  {hub.logins.map(({ login, onToggle }) => (
                    <MenuCheckboxItem
                      key={login.key}
                      checked={!login.disabled}
                      closeOnClick={false}
                      onCheckedChange={onToggle}
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <AccountChip email={login.email} image={login.image} />
                        <span className="min-w-0 truncate">{login.name ?? login.email}</span>
                      </span>
                    </MenuCheckboxItem>
                  ))}
                </MenuGroup>
              ))}
            </MenuSubPopup>
          </MenuSub>
        ) : null}
        <MenuItem onClick={onHide}>
          <EyeOffIcon aria-hidden />
          Hide {label}
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}

function PoolSection({
  pool,
  now,
  actions,
  hiddenLimits,
  showAccounts,
  routing,
  allOff,
}: {
  readonly pool: LimitPool;
  readonly now: number;
  readonly actions: ReactNode;
  readonly allOff: boolean;
  readonly hiddenLimits: ReadonlySet<string>;
  readonly showAccounts: boolean;
  readonly routing: RoutingReorder | null;
}) {
  const color = barColor(pool.driver);
  const label = providerClients.get(pool.driver)?.label ?? String(pool.driver);
  const windows = displayLimitWindows(pool).filter(
    (window) => !hiddenLimits.has(limitKey(pool, window)),
  );
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-sm font-medium text-foreground">
          <ProviderInstanceIcon
            driverKind={pool.driver}
            displayName={label}
            indicatorBackground="var(--background)"
            className="size-5"
            iconClassName="size-4 text-foreground/80"
          />
          {label}
        </h2>
        {actions}
      </div>
      {windows.map((window) => {
        const details =
          pool.driver === "cursor" ? cursorUsageWindowDetails(window.id, pool) : undefined;
        return (
          <PoolWindowCard
            key={`${window.kind}:${window.id}`}
            pool={window}
            color={color}
            now={now}
            label={details ? details.label : window.label}
            description={details?.description}
            showAccounts={showAccounts}
            routing={routing}
          />
        );
      })}
      {pool.windows.length === 0 && allOff ? (
        <p className="text-xs text-muted-foreground">Every hub account is off.</p>
      ) : null}
      <StaleReadings pool={pool} now={now} />
    </section>
  );
}

export function UsageLimitsPooled({
  presentations,
  now,
  providerOrder = PROVIDER_ORDER,
  onProviderOrderChange,
  onHideProvider,
  hiddenLimits = new Set(),
  onHiddenLimitsChange,
  hiddenAccountRows = new Set(),
  onHiddenAccountRowsChange,
}: {
  readonly presentations: Parameters<typeof collectLimitAccounts>[0];
  readonly now: number;
  readonly providerOrder?: readonly UsageProviderKind[];
  readonly onProviderOrderChange?: (order: readonly UsageProviderKind[]) => void;
  readonly onHideProvider?: (provider: UsageProviderKind) => void;
  readonly hiddenLimits?: ReadonlySet<string>;
  readonly onHiddenLimitsChange?: (hiddenLimits: readonly string[]) => void;
  readonly hiddenAccountRows?: ReadonlySet<UsageProviderKind>;
  readonly onHiddenAccountRowsChange?: (providers: readonly UsageProviderKind[]) => void;
}) {
  const rank = (pool: LimitPool) => {
    const provider = usageProviderForDriver(pool.driver);
    return provider ? providerOrder.indexOf(provider) : providerOrder.length;
  };
  const [pending, setPending] = useState<PendingHubChanges>(NO_PENDING_HUB_CHANGES);
  const resolved = hubLimitPools(presentations, pending, now);
  const { hubLogins } = resolved;
  // Dropped during render once the hub reports a change, or the login is gone.
  if (resolved.pending !== pending) setPending(resolved.pending);
  const pools = resolved.pools.toSorted((left, right) => rank(left) - rank(right));
  const environmentIds = [...presentations.keys()];
  const reorderPermissions = useAtomValue(
    reorderPermissionsAtom(environmentIdsKey(environmentIds)),
  );
  const mayRoute = (account: LimitAccount) =>
    account.routing !== null &&
    reorderPermissions[environmentIds.indexOf(account.routing.environmentId)] === true;
  const canReorder = (account: LimitAccount) => mayRoute(account) && !account.routing?.byReset;
  const setRouteByReset = useAtomCommand(
    serverEnvironment.setUsageLimitSourceRouteByReset,
    "Change hub routing",
  );
  const routeByResetFor = (pool: LimitPool) => {
    const routable = routeByResetHubs(pool, mayRoute);
    if (routable === null) return null;
    const { on, hubs } = routable;
    return {
      on,
      onToggle: () => {
        for (const [key, routing] of hubs) {
          setPending((previous) => ({
            ...previous,
            byReset: new Map([...previous.byReset, [key, !on]]),
          }));
          void setRouteByReset({
            environmentId: routing.environmentId,
            input: { sourceId: routing.sourceId, driver: pool.driver, enabled: !on },
          }).then((result) => {
            if (result._tag === "Failure") {
              setPending((previous) => ({
                ...previous,
                byReset: new Map([...previous.byReset].filter(([entry]) => entry !== key)),
              }));
            }
          });
        }
      },
    };
  };
  const disablePermissions = useAtomValue(
    disablePermissionsAtom(environmentIdsKey(environmentIds)),
  );
  const setAccountDisabled = useAtomCommand(
    serverEnvironment.setUsageLimitSourceAccountDisabled,
    "Change hub account",
  );
  const hubsFor = (pool: LimitPool) =>
    listHubs(
      hubLogins.filter(
        (login) =>
          login.driver === pool.driver &&
          disablePermissions[environmentIds.indexOf(login.environmentId)] === true,
      ),
    ).map((hub) => ({
      label: hub.label,
      logins: hub.logins.map((login) => ({
        login,
        onToggle: () => {
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
        },
      })),
    }));
  const setAccountOrder = useAtomCommand(
    serverEnvironment.setUsageLimitSourceAccountOrder,
    "Change hub routing order",
  );
  // One hub's logins in their new order, highest priority first.
  const sendOrder = (pool: LimitPool, accounts: readonly LimitAccount[]) => {
    const routing = accounts[0]?.routing;
    if (!routing) return;
    setPending((previous) => ({
      ...previous,
      routing: pendingRoutingFor(previous.routing, accounts),
    }));
    void setAccountOrder({
      environmentId: routing.environmentId,
      input: {
        sourceId: routing.sourceId,
        driver: pool.driver,
        accountIds: accounts.flatMap((account) => account.routing?.accountId ?? []),
      },
    }).then((result) => {
      if (result._tag === "Failure") setPending((previous) => ({ ...previous, routing: null }));
    });
  };
  const routingFor = (pool: LimitPool): RoutingReorder | null =>
    pool.accounts.some(canReorder)
      ? {
          canReorder,
          onReorder: (activeKey, overKey) => {
            const accounts = reorderedHubAccounts(pool.accounts, activeKey, overKey);
            if (accounts) sendOrder(pool, accounts);
          },
        }
      : null;
  const shownProviders = pools.flatMap((pool) => usageProviderForDriver(pool.driver) ?? []);
  const poolActions = (pool: LimitPool) => {
    const provider = usageProviderForDriver(pool.driver);
    if (
      !provider ||
      !onProviderOrderChange ||
      !onHideProvider ||
      !onHiddenLimitsChange ||
      !onHiddenAccountRowsChange
    )
      return null;
    const accountsShown = !hiddenAccountRows.has(provider);
    const index = shownProviders.indexOf(provider);
    const move = (offset: -1 | 1) => () =>
      onProviderOrderChange(moveProvider(providerOrder, shownProviders, provider, offset));
    return (
      <PoolActions
        label={providerClients.get(pool.driver)?.label ?? String(pool.driver)}
        limits={displayLimitWindows(pool).map((window) => {
          const key = limitKey(pool, window);
          const shown = !hiddenLimits.has(key);
          return {
            key,
            label: windowLabel(pool, window),
            shown,
            onToggle: () =>
              onHiddenLimitsChange(
                shown ? [...hiddenLimits, key] : [...hiddenLimits].filter((entry) => entry !== key),
              ),
          };
        })}
        accounts={{
          shown: accountsShown,
          onToggle: () =>
            onHiddenAccountRowsChange(
              accountsShown
                ? [...hiddenAccountRows, provider]
                : [...hiddenAccountRows].filter((entry) => entry !== provider),
            ),
        }}
        routeByReset={routeByResetFor(pool)}
        hubs={hubsFor(pool)}
        onMoveUp={index > 0 ? move(-1) : null}
        onMoveDown={index < shownProviders.length - 1 ? move(1) : null}
        onHide={() => onHideProvider(provider)}
      />
    );
  };
  const quotaSources = collectHttpQuotaSources(presentations);
  const notices = collectLimitNotices(presentations);
  const externalLinks = collectExternalUsageLinks(presentations);
  return (
    <div className="flex flex-col gap-8">
      {pools.length === 0 &&
      notices.length === 0 &&
      externalLinks.length === 0 &&
      quotaSources.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No provider on the selected environments reports subscription limits.
        </p>
      ) : null}
      {pools.map((pool) => (
        <Fragment key={pool.driver}>
          <PoolSection
            pool={pool}
            now={now}
            actions={poolActions(pool)}
            hiddenLimits={hiddenLimits}
            showAccounts={accountRowsShown(usageProviderForDriver(pool.driver), hiddenAccountRows)}
            routing={routingFor(pool)}
            allOff={hubLogins.every((login) => login.driver !== pool.driver || login.disabled)}
          />
        </Fragment>
      ))}
      {quotaSources.map((source) => (
        <section key={source.key} className="space-y-3 rounded-xl border p-4">
          <h2 className="text-sm font-medium">{source.label}</h2>
          {source.quotaAccounts?.map((account) => (
            <div key={account.id} className="space-y-1">
              <h3 className="text-sm font-medium">{account.label}</h3>
              {account.windows.map((window) => {
                const reset = formatResetsIn(window, now);
                return (
                  <div
                    key={window.id}
                    className="flex justify-between gap-3 text-sm text-muted-foreground"
                  >
                    <span>{window.label}</span>
                    <span>
                      {remainingPercent(window)}% left
                      {reset ? ` · ${reset}` : ""}
                    </span>
                  </div>
                );
              })}
            </div>
          ))}
        </section>
      ))}
      {externalLinks.map((link) => (
        <section
          key={link.url}
          className="flex flex-wrap items-center justify-between gap-3 rounded-xl border p-4"
        >
          <div className="flex min-w-0 flex-1 items-center gap-3">
            {link.url === CHATGPT_USAGE_URL ? (
              <OpenAI className="size-5 shrink-0" aria-hidden="true" />
            ) : null}
            <div className="min-w-0 space-y-1">
              <h2 className="text-sm font-medium">{link.label}</h2>
              <p className="text-xs break-words text-muted-foreground">
                {link.accounts.join(", ")}
              </p>
              {link.url === CHATGPT_USAGE_URL ? (
                <p className="text-xs text-muted-foreground">
                  View usage in ChatGPT with your connected account.
                </p>
              ) : link.message ? (
                <p className="max-w-xl text-xs text-muted-foreground">{link.message}</p>
              ) : null}
            </div>
          </div>
          <Button
            variant="ghost-muted"
            size="xs"
            onClick={() => void ensureLocalApi().shell.openExternal(link.url)}
          >
            Manage usage
            <ExternalLinkIcon className="size-3.5" aria-hidden="true" />
          </Button>
        </section>
      ))}
      <LimitNotices notices={notices} />
    </div>
  );
}

function LimitNotices({ notices }: { readonly notices: readonly string[] }) {
  if (notices.length === 0) return null;
  return (
    <Alert variant="warning" controlAlignment="first-line">
      <AlertTriangleIcon />
      {notices.map((notice) => (
        <AlertTitle key={notice} className="break-words">
          {notice}
        </AlertTitle>
      ))}
    </Alert>
  );
}
