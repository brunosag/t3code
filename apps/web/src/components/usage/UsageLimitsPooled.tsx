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
  type LimitPoolWindow,
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
  ListChecksIcon,
} from "lucide-react";
import { Fragment, type ReactNode } from "react";

import { ensureLocalApi } from "../../localApi";
import { cn } from "../../lib/utils";
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
}: {
  readonly pool: LimitPoolWindow;
  readonly color: string;
  readonly now: number;
}) {
  // Plan sizes only weigh the pool when every account's is known.
  const weighted = pool.members.every((member) => member.account.capacity !== undefined);
  return (
    <div className="grid grid-cols-[minmax(0,9rem)_minmax(3rem,1fr)_auto] items-center gap-x-3 md:grid-cols-[11rem_minmax(0,1fr)_auto] md:gap-x-6">
      {pool.members.map(({ account, window }) => {
        const name =
          account.displayName ??
          account.email ??
          providerClients.get(account.driver)?.label ??
          String(account.driver);
        const resetsAt = window.resetsAt ? Date.parse(window.resetsAt) : Number.NaN;
        return (
          <Fragment key={account.key}>
            <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
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
          </Fragment>
        );
      })}
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
}: {
  readonly pool: LimitPoolWindow;
  readonly color: string;
  readonly now: number;
  readonly label: string;
  readonly description?: string | undefined;
  readonly showAccounts: boolean;
}) {
  const runway = limitRunway(pool, now);
  const accounts = showAccounts ? <AccountRows pool={pool} color={color} now={now} /> : null;
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
}: {
  readonly pool: LimitPool;
  readonly now: number;
  readonly actions: ReactNode;
  readonly hiddenLimits: ReadonlySet<string>;
  readonly showAccounts: boolean;
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
  cursorPrompt,
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
  readonly cursorPrompt?: ReactNode;
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
  const pools = collectLimitPools(collectLimitAccounts(presentations), now).toSorted(
    (left, right) => rank(left) - rank(right),
  );
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
  const cursorPromptAt =
    Math.max(
      pools.findIndex((pool) => pool.driver === "codex"),
      pools.findIndex((pool) => pool.driver === "claudeAgent"),
    ) + 1;
  return (
    <div className="flex flex-col gap-8">
      {pools.length === 0 && notices.length === 0 && !cursorPrompt && externalLinks.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No provider on the selected environments reports subscription limits.
        </p>
      ) : null}
      {pools.map((pool, index) => (
        <Fragment key={pool.driver}>
          {index === cursorPromptAt ? cursorPrompt : null}
          <PoolSection
            pool={pool}
            now={now}
            actions={poolActions(pool)}
            hiddenLimits={hiddenLimits}
            showAccounts={pool.accounts.length > 1 && !accountRowsHidden(pool)}
          />
        </Fragment>
      ))}
      {cursorPromptAt === pools.length ? cursorPrompt : null}
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
