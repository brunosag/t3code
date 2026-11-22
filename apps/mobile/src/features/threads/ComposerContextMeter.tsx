import {
  contextWindowMeter,
  type ContextWindowUsage,
} from "@t3tools/client-runtime/state/context-window";
import { formatTokens } from "@t3tools/shared/usageFormat";
import type { ReactNode } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { UsageBar } from "../usage/UsageLimitsSection";

const FILL_CLASS = {
  error: "bg-red-500",
  warning: "bg-amber-500",
  none: "bg-foreground-muted",
} as const;

const LABEL_CLASS = {
  error: "text-danger-foreground",
  warning: "text-warning-foreground",
  none: "text-foreground-muted",
} as const;

/** The composer's context gauge: how full the window is, over a hairline that fills with it. */
export function ComposerContextMeter(props: {
  readonly usage: ContextWindowUsage;
  readonly size: "regular" | "large";
  /** The usage card it opens is showing. */
  readonly open: boolean;
  readonly onPress: () => void;
}) {
  const meter = contextWindowMeter(props.usage);
  const tone = meter.tone ?? "none";
  const tokens = formatTokens(props.usage.usedTokens);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={
        meter.usedPercent !== null
          ? `Context window, ${meter.usedPercent}% used`
          : `Context window, ${tokens} tokens used`
      }
      accessibilityHint={
        props.open ? "Hides context and usage limits" : "Shows context and usage limits"
      }
      accessibilityState={{ expanded: props.open }}
      className="h-[44px] shrink-0 items-center justify-center rounded-xl px-1.5 active:bg-subtle"
      onPress={props.onPress}
    >
      <View className="min-w-7 items-stretch gap-1">
        <Text
          className={`text-center font-t3-medium tabular-nums ${
            props.size === "large" ? "text-sm" : "text-xs"
          } ${LABEL_CLASS[tone]}`}
          numberOfLines={1}
        >
          {meter.usedPercent !== null ? `${meter.usedPercent}%` : tokens}
        </Text>
        {meter.usedPercent !== null ? (
          <View className="h-[3px] overflow-hidden rounded-full bg-subtle-strong">
            <View
              className={`h-full rounded-full ${FILL_CLASS[tone]}`}
              style={{ width: `${meter.usedPercent}%`, minWidth: meter.usedPercent > 0 ? 3 : 0 }}
            />
          </View>
        ) : null}
      </View>
    </Pressable>
  );
}

/** The context window in the usage card, laid out as one of its limit rows. */
export function ContextWindowSection(props: {
  readonly usage: ContextWindowUsage;
  readonly trailing?: ReactNode;
}) {
  const { usage } = props;
  const meter = contextWindowMeter(usage);
  const used = formatTokens(usage.usedTokens);
  const threshold = usage.autoCompactThreshold ?? null;
  return (
    <View className="gap-3 px-4 py-3">
      <View className="flex-row items-center gap-2">
        <Text className="min-w-0 flex-1 text-base font-t3-medium text-foreground">Context</Text>
        {props.trailing}
      </View>
      <View className="gap-1">
        <View className="flex-row items-baseline justify-between gap-3">
          <Text className="text-sm text-foreground">
            {usage.maxTokens != null && usage.maxTokens > 0
              ? `${used} of ${formatTokens(usage.maxTokens)} tokens`
              : `${used} tokens`}
          </Text>
          {meter.usedPercent !== null ? (
            <Text className="text-sm font-t3-medium tabular-nums text-foreground">
              {meter.usedPercent}% used
            </Text>
          ) : null}
        </View>
        {meter.usedPercent !== null ? (
          <UsageBar
            fill={meter.usedPercent}
            fillClassName={FILL_CLASS[meter.tone ?? "none"]}
            tick={meter.compactsAtPercent}
          />
        ) : null}
        {threshold !== null && threshold > 0 ? (
          <Text className="text-xs text-foreground-tertiary">
            compacts at about {formatTokens(threshold)}
          </Text>
        ) : null}
      </View>
    </View>
  );
}
