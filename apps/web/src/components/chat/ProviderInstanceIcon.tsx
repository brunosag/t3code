import { type CSSProperties, memo } from "react";
import { type ProviderDriverKind } from "@t3tools/contracts";
import { providerInstanceInitials } from "@t3tools/client-runtime/state/provider-instance-display";

import { type ModelVendorGlyph, PROVIDER_ICON_BY_PROVIDER } from "./providerIconUtils";
import { cn } from "~/lib/utils";

export { providerInstanceInitials };

export const ProviderInstanceIcon = memo(function ProviderInstanceIcon(props: {
  driverKind: ProviderDriverKind;
  displayName: string;
  accentColor?: string | undefined;
  showBadge?: boolean;
  badgeContent?: "initials" | "none";
  className?: string;
  iconClassName?: string;
  badgeClassName?: string;
  statusDotClassName?: string;
  indicatorBackground?: string;
  /** Model vendor glyph(s) shown instead of the provider glyph, from `resolveModelVendorIcon`. */
  vendorGlyph?: ModelVendorGlyph | undefined;
}) {
  const Icon = props.vendorGlyph?.icon ?? PROVIDER_ICON_BY_PROVIDER[props.driverKind] ?? null;
  const OverlayIcon = props.vendorGlyph?.overlayIcon ?? null;
  const indicatorBackground = props.indicatorBackground ?? "var(--card)";
  const accentStyle = props.accentColor
    ? ({ "--provider-accent": props.accentColor } as CSSProperties)
    : undefined;
  const badgeContent = props.badgeContent ?? "initials";
  // B³ chip: a 55%-black scrim keeps the white provider mark readable while
  // the vendor glyph shows through it.
  const overlayBackground = "rgba(0, 0, 0, 0.55)";
  // The provider overlay claims the bottom-right corner the account badge
  // would sit in; the instance stays named by the row's label and tooltip.
  const showBadge = props.showBadge === true && OverlayIcon === null;

  return (
    <span
      className={cn(
        "relative isolate z-30 inline-flex shrink-0 items-center justify-center overflow-visible",
        props.className,
      )}
      style={accentStyle}
      data-provider-accent-color={props.accentColor}
    >
      {Icon ? (
        <Icon className={cn("size-5 shrink-0", props.iconClassName)} aria-hidden />
      ) : (
        <span className={cn("text-[10px] font-semibold leading-none", props.iconClassName)}>
          {providerInstanceInitials(props.displayName)}
        </span>
      )}
      {OverlayIcon ? (
        <span
          className={cn(
            "pointer-events-none absolute -bottom-[8%] -right-[8%] z-10 flex aspect-square w-[64%] min-w-2 items-center justify-center rounded-[27%]",
            "text-white",
          )}
          style={{ backgroundColor: overlayBackground }}
          aria-hidden
        >
          <OverlayIcon className="size-[67%] text-white" />
        </span>
      ) : null}
      {props.statusDotClassName ? (
        <span
          className={cn(
            "pointer-events-none absolute -left-0.5 -top-0.5 z-10 size-2 rounded-full",
            props.statusDotClassName,
          )}
          style={{ boxShadow: `0 0 0 2px ${indicatorBackground}` }}
          aria-hidden
        />
      ) : null}
      {showBadge ? (
        <span
          className={cn(
            "pointer-events-none absolute right-0 bottom-0 z-10 flex h-3.5 min-w-3.5 items-center justify-center rounded-full border px-0.5 text-[8px] font-semibold leading-none shadow-sm",
            props.accentColor
              ? "bg-[var(--provider-accent)] text-white"
              : "bg-card text-muted-foreground",
            props.badgeClassName,
          )}
          style={{ borderColor: indicatorBackground }}
          aria-hidden
        >
          {badgeContent === "initials" ? providerInstanceInitials(props.displayName) : null}
        </span>
      ) : null}
    </span>
  );
});
