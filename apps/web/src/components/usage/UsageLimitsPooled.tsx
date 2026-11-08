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
  CHATGPT_USAGE_URL,
  collectLimitAccounts,
  collectExternalUsageLinks,
  collectLimitNotices,
  collectLimitPools,
  cursorUsageWindowDetails,
  displayLimitWindows,
  formatDuration,
  type LimitAccount,
  type LimitPool,
  type LimitPoolMember,
  type LimitPoolWindow,
  limitRoutingKey,
  remainingPercent,
} from "@t3tools/shared/usageLimits";
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
  ScaleIcon,
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
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../ui/menu";
import { AccountChip } from "./AccountChip";
import { ResetCredits, WindowBar, barColor } from "./UsageLimits";
import { BalanceCard, RunwayCard } from "./UsageLimitRunway";
import { moveProvider, PROVIDER_ORDER, usageProviderForDriver } from "./usageProviders";
import {
  type PendingRouting,
  pendingRoutingSettled,
  reorderedHubAccounts,
  withPendingRouting,
} from "./usageRouting";

const reorderPermissionsAtom = environmentAtomList(
  "web-usage-limit-routing-permissions",
  serverEnvironment.setUsageLimitSourceAccountOrder.permissionAtom,
);

/** Reorders hub logins; null where the viewer may not change this pool's routing. */
type RoutingReorder = {
  readonly canReorder: (account: LimitAccount) => boolean;
  readonly onReorder: (activeKey: string, overKey: string) => void;
};

function AccountName({
  account,
  className,
}: {
  readonly account: LimitAccount;
  readonly className?: string;
}) {
  const name =
    account.displayName ??
    (account.email ? null : (providerClients.get(account.driver)?.label ?? String(account.driver)));
  if (!account.image && name) return <span className={className}>{name}</span>;
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1.5", className)}>
      <AccountChip email={account.email} image={account.image} />
      {name ? <span className="min-w-0 truncate">{name}</span> : null}
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
  const grid = (
    <div className="grid grid-cols-[minmax(0,9rem)_minmax(3rem,1fr)_auto] items-center gap-x-3 md:grid-cols-[11rem_minmax(0,1fr)_auto] md:gap-x-6">
      {pool.members.map((member) => (
        <AccountRow
          key={member.account.key}
          member={member}
          weighted={weighted}
          color={color}
          now={now}
          grip={sortable ? (movable.includes(member.account.key) ? "handle" : "space") : "none"}
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
}: {
  readonly member: LimitPoolMember;
  readonly weighted: boolean;
  readonly color: string;
  readonly now: number;
  readonly grip: "handle" | "space" | "none";
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
  const name =
    account.displayName ??
    account.email ??
    providerClients.get(account.driver)?.label ??
    String(account.driver);
  const resetsAt = window.resetsAt ? Date.parse(window.resetsAt) : Number.NaN;
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(
        "col-span-3 grid grid-cols-subgrid items-center",
        isDragging && "relative z-10 rounded-md bg-background shadow-md",
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
        <span className="ms-auto shrink-0 tabular-nums">{remainingPercent(window)}%</span>
      </span>
      <WindowBar thin color={color} window={window} now={now} label={name} />
      <span className="text-end text-xs whitespace-nowrap text-muted-foreground tabular-nums">
        {resetsAt > now ? `in ${formatDuration(resetsAt - now)}` : null}
      </span>
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
  readonly label: string;
  readonly description?: string | undefined;
  readonly showAccounts: boolean;
  readonly routing: RoutingReorder | null;
}) {
  const runway = limitRunway(pool, now);
  const accounts = showAccounts ? (
    <AccountRows pool={pool} color={color} now={now} routing={routing} />
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

/** Credits belong to one login, so they list by account even with account rows hidden. */
function ResetCreditRows({ pool, now }: { readonly pool: LimitPool; readonly now: number }) {
  const banked = pool.accounts.flatMap((account) =>
    account.redeem && account.limits.resetCredits?.availableCount
      ? [{ account, redeem: account.redeem, credits: account.limits.resetCredits }]
      : [],
  );
  if (banked.length === 0) return null;
  return (
    <div className="flex flex-col gap-2 px-1">
      {banked.map(({ account, redeem, credits }) => (
        <div key={account.key} className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <AccountName account={account} className="text-xs font-medium text-foreground" />
          <ResetCredits
            environmentId={redeem.environmentId}
            input={redeem.input}
            credits={credits}
            now={now}
          />
        </div>
      ))}
    </div>
  );
}

function windowLabel(pool: LimitPool, window: LimitPoolWindow) {
  return (
    (pool.driver === "cursor" ? cursorUsageWindowDetails(window.id)?.label : undefined) ??
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
  onMoveUp,
  onMoveDown,
  onBalance,
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
  readonly accounts: { readonly shown: boolean; readonly onToggle: () => void } | null;
  readonly onMoveUp: (() => void) | null;
  readonly onMoveDown: (() => void) | null;
  /** Null unless the hub routes this pool's logins at different priorities. */
  readonly onBalance: (() => void) | null;
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
        {accounts ? (
          <MenuCheckboxItem
            checked={accounts.shown}
            closeOnClick={false}
            onCheckedChange={accounts.onToggle}
          >
            Show accounts
          </MenuCheckboxItem>
        ) : null}
        {onBalance ? (
          <MenuItem onClick={onBalance}>
            <ScaleIcon aria-hidden />
            Balance hub routing
          </MenuItem>
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
}: {
  readonly pool: LimitPool;
  readonly now: number;
  readonly actions: ReactNode;
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
        const details = pool.driver === "cursor" ? cursorUsageWindowDetails(window.id) : undefined;
        return (
          <PoolWindowCard
            key={`${window.kind}:${window.id}`}
            pool={window}
            color={color}
            now={now}
            label={details?.label ?? window.label}
            description={details?.description}
            showAccounts={showAccounts}
            routing={routing}
          />
        );
      })}
      <ResetCreditRows pool={pool} now={now} />
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
  const [pendingRouting, setPendingRouting] = useState<PendingRouting | null>(null);
  const reported = collectLimitAccounts(presentations);
  // Dropped during render so an optimistic order never outlives the hub report it was for.
  if (pendingRouting !== null && pendingRoutingSettled(reported, pendingRouting)) {
    setPendingRouting(null);
  }
  const pools = collectLimitPools(withPendingRouting(reported, pendingRouting), now).toSorted(
    (left, right) => rank(left) - rank(right),
  );
  const environmentIds = [...presentations.keys()];
  const reorderPermissions = useAtomValue(
    reorderPermissionsAtom(environmentIdsKey(environmentIds)),
  );
  const canReorder = (account: LimitAccount) =>
    account.routing !== null &&
    reorderPermissions[environmentIds.indexOf(account.routing.environmentId)] === true;
  const setAccountOrder = useAtomCommand(
    serverEnvironment.setUsageLimitSourceAccountOrder,
    "Change hub routing order",
  );
  // Each hub's logins in their new order, highest priority first; null ties them.
  const sendOrder = (
    pool: LimitPool,
    hubs: ReadonlyArray<{ readonly accounts: readonly LimitAccount[]; readonly balance: boolean }>,
  ) => {
    const expected = new Map(
      hubs.flatMap(({ accounts, balance }) =>
        accounts.map((account, index) => [account.key, balance ? 0 : accounts.length - 1 - index]),
      ),
    );
    setPendingRouting((previous) => new Map([...(previous ?? []), ...expected]));
    for (const { accounts, balance } of hubs) {
      const routing = accounts[0]?.routing;
      if (!routing) continue;
      void setAccountOrder({
        environmentId: routing.environmentId,
        input: {
          sourceId: routing.sourceId,
          driver: pool.driver,
          accountIds: balance
            ? null
            : accounts.flatMap((account) => account.routing?.accountId ?? []),
        },
      }).then((result) => {
        if (result._tag === "Failure") setPendingRouting(null);
      });
    }
  };
  const routingFor = (pool: LimitPool): RoutingReorder | null =>
    pool.accounts.some(canReorder)
      ? {
          canReorder,
          onReorder: (activeKey, overKey) => {
            const accounts = reorderedHubAccounts(pool.accounts, activeKey, overKey);
            if (accounts) sendOrder(pool, [{ accounts, balance: false }]);
          },
        }
      : null;
  const balanceFor = (pool: LimitPool) => {
    const hubs = new Map<string | null, LimitAccount[]>();
    for (const account of pool.accounts.filter(canReorder)) {
      const hub = limitRoutingKey(account);
      hubs.set(hub, [...(hubs.get(hub) ?? []), account]);
    }
    const uneven = [...hubs.values()].filter(
      (accounts) => new Set(accounts.map((account) => account.routing?.priority)).size > 1,
    );
    return uneven.length === 0
      ? null
      : () =>
          sendOrder(
            pool,
            uneven.map((accounts) => ({ accounts, balance: true })),
          );
  };
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
        accounts={
          pool.accounts.length > 1
            ? {
                shown: accountsShown,
                onToggle: () =>
                  onHiddenAccountRowsChange(
                    accountsShown
                      ? [...hiddenAccountRows, provider]
                      : [...hiddenAccountRows].filter((entry) => entry !== provider),
                  ),
              }
            : null
        }
        onMoveUp={index > 0 ? move(-1) : null}
        onMoveDown={index < shownProviders.length - 1 ? move(1) : null}
        onBalance={balanceFor(pool)}
        onHide={() => onHideProvider(provider)}
      />
    );
  };
  const accountRowsHidden = (pool: LimitPool) => {
    const provider = usageProviderForDriver(pool.driver);
    return provider !== undefined && hiddenAccountRows.has(provider);
  };
  const notices = collectLimitNotices(presentations);
  const externalLinks = collectExternalUsageLinks(presentations);
  return (
    <div className="flex flex-col gap-8">
      {pools.length === 0 && notices.length === 0 && externalLinks.length === 0 ? (
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
            showAccounts={pool.accounts.length > 1 && !accountRowsHidden(pool)}
            routing={routingFor(pool)}
          />
        </Fragment>
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
