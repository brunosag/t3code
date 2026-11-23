import { AuthProvidersManageScope, type EnvironmentId } from "@t3tools/contracts";
import {
  type BankedReset,
  formatExpiresIn,
  formatExpiryDate,
  RESET_EXPIRY_SOON_MS,
} from "@t3tools/shared/usageLimits";
import { useState } from "react";
import { Pressable } from "react-native";

import * as Dialog from "../../components/ui/Dialog";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { cn } from "../../lib/cn";
import { serverEnvironment } from "../../state/server";
import { readEnvironmentScope, useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { AccountChip } from "./AccountChip";
import { m } from "../../i18n/messages";
import { RESET_OUTCOME_TEXT } from "./UsageLimitsSection";

/** One kind of banked reset on an account: its count and soonest expiry; tapping lists every expiry and redeems. */
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
  const [busy, setBusy] = useState(false);
  const next = reset.expiries[0];
  const nextIn = next === undefined ? null : formatExpiresIn(next - now);

  const redeem = async () => {
    if (!readEnvironmentScope(environmentId, AuthProvidersManageScope)) return;
    setBusy(true);
    const result = await consume({ environmentId, input: reset.input });
    setBusy(false);
    Dialog.alert(
      result._tag === "Success"
        ? (result.value.warning ?? m(RESET_OUTCOME_TEXT[result.value.outcome]))
        : "error" in result.cause && result.cause.error instanceof Error
          ? result.cause.error.message
          : "Could not use the reset credit.",
    );
  };

  const open = () => {
    const lines = [
      ...reset.expiries.map(
        (at) => `in ${formatExpiresIn(at - now)} · ${formatExpiryDate(at, now)}`,
      ),
      ...Array.from(
        { length: Math.max(0, reset.availableCount - reset.expiries.length) },
        () => "Never",
      ),
    ];
    Dialog.alert(
      `${accountName} · ${reset.label}`,
      `Expires\n${lines.join("\n")}`,
      canManage
        ? [
            { text: "Cancel", style: "cancel" },
            { text: "Use reset", onPress: () => void redeem() },
          ]
        : [{ text: "OK", style: "cancel" }],
    );
  };

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${accountName}: ${reset.availableCount} ${reset.label.toLowerCase()}${reset.availableCount === 1 ? "" : "s"}${nextIn ? `, next expires in ${nextIn}` : ""}`}
      disabled={busy}
      onPress={open}
      hitSlop={8}
      className="flex-row items-center gap-1 rounded-full border border-border bg-subtle-strong px-2 py-0.5 active:opacity-60"
    >
      {chip ? <AccountChip email={chip.email} image={chip.image} /> : null}
      <SymbolView name="arrow.clockwise" size={11} tintColorClassName="accent-foreground-muted" />
      <Text className="text-xs font-t3-medium tabular-nums text-foreground">
        {busy ? "…" : reset.availableCount}
      </Text>
      {nextIn ? (
        <Text
          className={cn(
            "text-xs tabular-nums text-foreground-tertiary",
            next !== undefined && next - now < RESET_EXPIRY_SOON_MS && "text-warning-foreground",
          )}
        >
          {nextIn}
        </Text>
      ) : null}
    </Pressable>
  );
}
