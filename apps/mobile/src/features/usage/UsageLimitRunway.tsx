import type { LimitRunway, RunwayPoint } from "@t3tools/shared/usageLimitRunway";
import type { LimitPace, LimitPoolWindow } from "@t3tools/shared/usageLimits";
import { useId, useState } from "react";
import { View } from "react-native";
import { Defs, Line, Path, Pattern, Polygon, Polyline, Rect, Svg } from "react-native-svg";
import { useResolveClassNames } from "uniwind";

import { AppText as Text } from "../../components/ui/AppText";
import { cn } from "../../lib/cn";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const CHART_HEIGHT = 112;
const timeFormatter = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const hourFormatter = new Intl.DateTimeFormat(undefined, { hour: "numeric" });
const weekdayFormatter = new Intl.DateTimeFormat(undefined, { weekday: "short" });
const dateFormatter = new Intl.DateTimeFormat(undefined, { month: "numeric", day: "numeric" });

function startOfDay(at: number) {
  const date = new Date(at);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** The time today, "tomorrow at", a weekday within the week, or a date beyond. */
export function formatAt(at: number, now: number) {
  const days = Math.round((startOfDay(at) - startOfDay(now)) / DAY);
  const time = timeFormatter.format(at);
  if (days === 0) return time;
  if (days === 1) return `tomorrow at ${time}`;
  if (days > 1 && days < 7) return `${weekdayFormatter.format(at)} ${time}`;
  return `${dateFormatter.format(at)} ${time}`;
}

const PACE: Record<LimitPace, { readonly label: string; readonly className: string }> = {
  ahead: { label: "Slow down", className: "text-warning-foreground" },
  on: { label: "On pace", className: "text-foreground" },
  under: { label: "Room to spare", className: "text-emerald-600" },
};

function formatRate(rate: number) {
  return rate > 0 && rate < 1 ? "<1%" : `${Math.round(rate)}%`;
}

/**
 * The pooled figure and what the burn means for it. Day-or-longer windows judge the burn against
 * the safe pace; session-length ones burn in bursts, so they show where the recent burn leads.
 */
export function PoolFigures({
  pool,
  runway,
  label,
  now,
}: {
  readonly pool: LimitPoolWindow;
  readonly runway: LimitRunway | null;
  /** Null leaves the provider heading to name a pool's only figure. */
  readonly label: string | null;
  readonly now: number;
}) {
  const empty = pool.remainingPercent === 0;
  const lines: { readonly key: string; readonly text: string; readonly strong?: string }[] = [];
  let status: { readonly text: string; readonly className: string } | null = null;
  if (runway?.paced) {
    const { burnPerDay: burn, safe, pace } = runway;
    if (empty && runway.refills[0]) {
      status = {
        text: `Out until ${formatAt(runway.refills[0].at, now)}`,
        className: "text-warning-foreground",
      };
    } else if (pace) {
      status = { text: PACE[pace].label, className: PACE[pace].className };
    }
    if (!empty && burn !== null)
      lines.push({ key: "burn", text: "Using ", strong: `${formatRate(burn)}/day` });
    if (!empty && safe) {
      const fast = pace === "ahead";
      lines.push({
        key: "safe",
        text: `${fast ? "Stay under" : "Up to"} ${formatRate(safe.perDay)}/day ${fast ? "until" : "lasts until"} ${formatAt(safe.until, now)}`,
      });
    }
  } else {
    // The chart labels its refills at the current burn, so the text does too.
    const refill = runway?.refills[0];
    const next = refill
      ? { at: refill.at, restoresPercent: Math.round(refill.percent) }
      : pool.resets.find((reset) => reset.at > now && reset.restoresPercent > 0);
    const burn = empty ? null : (runway?.burnPerDay ?? null);
    const runsOut = runway?.out ?? null;
    if (burn !== null) {
      lines.push({ key: "burn", text: "Using ", strong: `${formatRate(burn / 24)}/h` });
      lines.push({
        key: "out",
        text: runsOut ? `Runs out ${formatAt(runsOut.at, now)} at this rate` : "Lasts at this rate",
      });
    }
    if (next && empty) {
      status = {
        text: `Out until ${formatAt(next.at, now)}`,
        className: "text-warning-foreground",
      };
    } else if (next) {
      lines.push({ key: "next", text: `+${next.restoresPercent}% at ${formatAt(next.at, now)}` });
    }
  }
  return (
    <View className="gap-1">
      {label !== null ? (
        <Text className="text-sm font-t3-medium text-foreground">{label}</Text>
      ) : null}
      <View className="flex-row items-baseline gap-1.5">
        <Text className="text-3xl font-t3-bold tabular-nums text-foreground">
          {pool.remainingPercent}%
        </Text>
        <Text className="text-sm text-foreground-muted">left</Text>
      </View>
      {status ? (
        <Text className={cn("text-sm font-t3-medium", status.className)}>{status.text}</Text>
      ) : null}
      {lines.map((line) => (
        <Text key={line.key} className="text-xs tabular-nums text-foreground-muted">
          {line.text}
          {line.strong ? (
            <Text className="text-xs font-t3-medium tabular-nums text-foreground">
              {line.strong}
            </Text>
          ) : null}
        </Text>
      ))}
    </View>
  );
}

/** Hours for spans under a day, weekday names centred on each day, or a date each week beyond. */
function axisTicks(from: number, to: number) {
  const ticks: Array<{ at: number; label: string }> = [];
  if (to - from < DAY) {
    const step = to - from <= 12 * HOUR ? 2 * HOUR : 4 * HOUR;
    for (let at = startOfDay(from); at < to; at += step) {
      if (at > from) ticks.push({ at, label: hourFormatter.format(at) });
    }
    return ticks;
  }
  const weekly = to - from <= 10 * DAY;
  for (
    let day = startOfDay(from) + DAY;
    day < to;
    day = startOfDay(day + (weekly ? 1.5 : 7.5) * DAY)
  ) {
    const at = weekly ? day + DAY / 2 : day;
    if (at > from && at < to) {
      ticks.push({ at, label: weekly ? weekdayFormatter.format(at) : dateFormatter.format(at) });
    }
  }
  return ticks;
}

const LABEL_WIDTH = 64;

/** Recorded balance, the projection ahead, refills and where the burn runs out. */
export function RunwayChart({
  runway,
  color,
  now,
  label,
}: {
  readonly runway: LimitRunway;
  readonly color: string;
  readonly now: number;
  readonly label: string;
}) {
  const patternId = useId().replace(/:/g, "");
  const [width, setWidth] = useState(0);
  const { color: warning } = useResolveClassNames("text-warning-foreground");
  const { color: border } = useResolveClassNames("text-border");
  const span = runway.to - runway.from;
  const x = (at: number) =>
    ((Math.min(Math.max(at, runway.from), runway.to) - runway.from) / span) * width;
  const y = (remaining: number) =>
    ((100 - Math.min(Math.max(remaining, 0), 100)) / 100) * CHART_HEIGHT;
  const line = (points: readonly RunwayPoint[]) =>
    points.map((point) => `${x(point.at)},${y(point.remaining)}`).join(" ");
  const area = (points: readonly RunwayPoint[]) =>
    points.length > 0
      ? `${x(points[0]!.at)},${CHART_HEIGHT} ${line(points)} ${x(points.at(-1)!.at)},${CHART_HEIGHT}`
      : "";
  const out = runway.out;
  const outShown = out !== null && out.at < runway.to;
  const centred = (left: number) => ({ left: left - LABEL_WIDTH / 2, width: LABEL_WIDTH });
  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel={`${label} quota over time${out ? `, runs out ${formatAt(out.at, now)} at this rate` : ""}`}
      className="min-w-0 pt-8"
    >
      <View
        style={{ height: CHART_HEIGHT }}
        onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
      >
        {width > 0 ? (
          <>
            <Svg
              width={width}
              height={CHART_HEIGHT}
              accessible={false}
              style={{ position: "absolute", overflow: "visible" }}
            >
              <Defs>
                <Pattern id={patternId} width={6} height={6} patternUnits="userSpaceOnUse">
                  <Path d="M-1 1L1 -1M0 6L6 0M5 7L7 5" stroke={warning} strokeWidth={1.5} />
                </Pattern>
              </Defs>
              <Line x1={0} x2={width} y1={0.5} y2={0.5} stroke={border} strokeDasharray="3 3" />
              {outShown ? (
                <Rect
                  x={x(out.at)}
                  width={x(out.until) - x(out.at)}
                  height={CHART_HEIGHT}
                  fill={`url(#${patternId})`}
                  opacity={0.4}
                />
              ) : null}
              {runway.past.map((stretch) => (
                <Polygon
                  key={`area:${stretch[0]!.at}`}
                  points={area(stretch)}
                  fill={color}
                  fillOpacity={0.3}
                />
              ))}
              {runway.past.map((stretch) => (
                <Polyline
                  key={`line:${stretch[0]!.at}`}
                  points={line(stretch)}
                  fill="none"
                  stroke={color}
                  strokeWidth={2}
                />
              ))}
              <Polygon points={area(runway.projection)} fill={color} fillOpacity={0.1} />
              <Polyline
                points={line(runway.projection)}
                fill="none"
                stroke={color}
                strokeWidth={1.5}
                strokeDasharray="4 3"
              />
              <Line
                x1={0}
                x2={width}
                y1={CHART_HEIGHT - 0.5}
                y2={CHART_HEIGHT - 0.5}
                stroke={border}
              />
            </Svg>
            {outShown ? (
              <Text
                numberOfLines={1}
                className="absolute top-0.5 text-[10px] font-t3-medium text-warning-foreground"
                // Too close to now, the label would run over the now marker, so it goes inside the band.
                style={
                  x(out.at) - x(now) < width / 4
                    ? { left: x(out.at) + 6 }
                    : { right: width - x(out.at) + 6 }
                }
              >
                out {formatAt(out.at, now)}
              </Text>
            ) : null}
            <View
              pointerEvents="none"
              className="absolute bottom-0 w-px bg-foreground opacity-70"
              style={{ left: x(now), top: -14 }}
            />
            <Text
              className="absolute text-center text-[10px] font-t3-bold text-foreground"
              style={{ top: -30, ...centred(x(now)) }}
            >
              now
            </Text>
            {runway.refills.map((refill) => {
              const top =
                runway.projection.findLast((point) => point.at === refill.at)?.remaining ?? 0;
              return (
                <Text
                  key={refill.at}
                  className="absolute text-center text-[10px] font-t3-bold tabular-nums text-foreground"
                  style={{ top: y(top) - 15, ...centred(x(refill.at)) }}
                >
                  +{Math.round(refill.percent)}%
                </Text>
              );
            })}
          </>
        ) : null}
      </View>
      <View className="mt-1 h-4">
        {width > 0
          ? axisTicks(runway.from, runway.to).map((tick) => (
              <Text
                key={tick.at}
                numberOfLines={1}
                className="absolute text-center text-[10px] text-foreground-muted"
                style={centred(x(tick.at))}
              >
                {tick.label}
              </Text>
            ))
          : null}
      </View>
    </View>
  );
}
