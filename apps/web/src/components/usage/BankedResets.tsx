import { AuthProvidersManageScope, type EnvironmentId } from "@t3tools/contracts";
import {
  type BankedReset,
  formatExpiresIn,
  formatExpiryDate,
  RESET_EXPIRY_SOON_MS,
} from "@t3tools/shared/usageLimits";
import { useMessages } from "gt-react";
import { RotateCcwIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "../../lib/utils";
import { readEnvironmentScope, useEnvironmentScope } from "../../state/session";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Popover, PopoverClose, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";
import { toastManager } from "../ui/toast";
import { AccountChip } from "./AccountChip";
import { RESET_OUTCOME_TEXT } from "./UsageLimits";

const soon = (expiresAt: number | undefined, now: number) =>
  expiresAt !== undefined && expiresAt - now < RESET_EXPIRY_SOON_MS;

/** One kind of banked reset on an account: its count and soonest expiry, opening the expiries and redeem. */
export function BankedResetButton({
  reset,
  environmentId,
  accountName,
  chip,
  now,
}: {
  readonly reset: BankedReset;
  readonly environmentId: EnvironmentId;
  readonly accountName: string;
  /** Shown where the button stands without its account's row. */
  readonly chip?: { readonly email: string | undefined; readonly image: string | undefined };
  readonly now: number;
}) {
  const canManage = useEnvironmentScope(environmentId, AuthProvidersManageScope);
  const consume = useAtomCommand(serverEnvironment.consumeResetCredit, { reportFailure: false });
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const m = useMessages();
  const next = reset.expiries[0];
  const rows = [
    ...reset.expiries,
    ...Array.from(
      { length: Math.max(0, reset.availableCount - reset.expiries.length) },
      () => null,
    ),
  ];

  const redeem = async () => {
    if (!readEnvironmentScope(environmentId, AuthProvidersManageScope)) return;
    setBusy(true);
    const result = await consume({ environmentId, input: reset.input });
    setBusy(false);
    setOpen(false);
    if (result._tag === "Success") {
      toastManager.add({
        type: result.value.outcome === "reset" ? "success" : "info",
        title: result.value.warning ?? m(RESET_OUTCOME_TEXT[result.value.outcome]),
      });
      return;
    }
    toastManager.add({
      type: "error",
      title:
        "error" in result.cause && result.cause.error instanceof Error
          ? result.cause.error.message
          : "Could not use the reset credit.",
    });
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            className="inline-flex h-6 cursor-pointer items-center gap-1.5 justify-self-start rounded-md border border-border bg-secondary/60 px-2 text-xs whitespace-nowrap text-muted-foreground tabular-nums outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset data-popup-open:border-border data-popup-open:bg-accent"
          />
        }
        aria-label={`${accountName}: ${reset.availableCount} ${reset.label.toLowerCase()}${reset.availableCount === 1 ? "" : "s"}${next === undefined ? "" : `, next expires in ${formatExpiresIn(next - now)}`}`}
      >
        {chip ? <AccountChip email={chip.email} image={chip.image} /> : null}
        <RotateCcwIcon aria-hidden className="size-3 shrink-0" />
        <span className="font-medium text-foreground">{reset.availableCount}</span>
        {next === undefined ? null : (
          <span className={cn(soon(next, now) && "text-warning")}>
            {formatExpiresIn(next - now)}
          </span>
        )}
      </PopoverTrigger>
      <PopoverPopup side="bottom" align="end" width="sm">
        <PopoverTitle>{reset.label}</PopoverTitle>
        <p className="mt-3 mb-1.5 text-2xs text-muted-foreground">Expires</p>
        <ul className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-xs tabular-nums">
          {rows.map((at, index) => (
            // oxlint-disable-next-line react/no-array-index-key -- resets with one expiry are interchangeable
            <li key={index} className="col-span-2 grid grid-cols-subgrid">
              {at === null ? (
                <span className="text-muted-foreground">Never</span>
              ) : (
                <>
                  <span className={soon(at, now) ? "text-warning" : "text-foreground"}>
                    in {formatExpiresIn(at - now)}
                  </span>
                  <span className="text-end text-muted-foreground">
                    {formatExpiryDate(at, now)}
                  </span>
                </>
              )}
            </li>
          ))}
        </ul>
        <div className="mt-4 flex justify-end gap-2">
          <PopoverClose render={<Button size="sm" variant="outline" />}>Cancel</PopoverClose>
          <Button size="sm" disabled={busy || !canManage} onClick={() => void redeem()}>
            {busy ? "Using…" : "Use reset"}
          </Button>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
