import type { LimitRunway, RunwayPoint } from "@t3tools/shared/usageLimitRunway";
import type { LimitPace, LimitPoolWindow } from "@t3tools/shared/usageLimits";
import type { TimestampFormat } from "@t3tools/contracts";
import type { ReactNode } from "react";

import { usePrimarySettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { formatShortTimestamp, formatUpcomingTimestamp } from "../../timestampFormat";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const weekdayFormatter = new Intl.DateTimeFormat(undefined, { weekday: "short" });
const dateFormatter = new Intl.DateTimeFormat(undefined, { month: "numeric", day: "numeric" });

function formatAt(at: number, timestampFormat: TimestampFormat, now: number) {
  const iso = new Date(at).toISOString();
  const days = Math.round((startOfDay(at) - startOfDay(now)) / DAY);
  if (days < 2 || days > 6) return formatUpcomingTimestamp(iso, timestampFormat, now);
  return `${weekdayFormatter.format(at)} ${formatShortTimestamp(iso, timestampFormat)}`;
}

function startOfDay(at: number) {
  const date = new Date(at);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

const PACE: Record<LimitPace, { readonly label: string; readonly className: string }> = {
  ahead: { label: "Slow down", className: "text-warning" },
  on: { label: "On pace", className: "text-foreground" },
  under: { label: "Room to spare", className: "text-success" },
};

function formatRate(perDay: number) {
  return perDay > 0 && perDay < 1 ? "<1%" : `${Math.round(perDay)}%`;
}

function Card({
  description,
  accounts,
  children,
}: {
  readonly description: string | undefined;
  readonly accounts: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <div className="grid items-center gap-x-6 gap-y-3 rounded-lg border border-border/60 p-4 md:grid-cols-[11rem_minmax(0,1fr)]">
      {children}
      {description ? (
        <p className="text-xs text-muted-foreground md:col-span-2">{description}</p>
      ) : null}
      {accounts ? (
        <div className="border-t border-border/60 pt-3 md:col-span-2">{accounts}</div>
      ) : null}
    </div>
  );
}

function Headline({ label, remaining }: { readonly label: string; readonly remaining: number }) {
  return (
    <>
      <span className="text-sm font-medium text-foreground">{label}</span>
      <span className="flex items-baseline gap-2">
        <span className="text-3xl font-semibold text-foreground tabular-nums">{remaining}%</span>
        <span className="text-sm text-muted-foreground">left</span>
      </span>
    </>
  );
}

/** Session-length windows burn in bursts, so they show what is left and when more arrives, without a pace. */
export function BalanceCard({
  pool,
  runway,
  label,
  description,
  accounts,
  color,
  now,
}: {
  readonly pool: LimitPoolWindow;
  readonly runway: LimitRunway | null;
  readonly label: string;
  readonly description: string | undefined;
  /** Each account's own reading, under the pooled figure. */
  readonly accounts?: ReactNode;
  readonly color: string;
  readonly now: number;
}) {
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const next = pool.resets.find((reset) => reset.restoresPercent > 0);
  const out = pool.remainingPercent === 0;
  return (
    <Card description={description} accounts={accounts}>
      <div className="flex flex-col gap-1">
        <Headline label={label} remaining={pool.remainingPercent} />
        {next ? (
          <span
            className={cn(
              "tabular-nums",
              out ? "mt-1 text-sm font-medium text-warning" : "text-xs text-muted-foreground",
            )}
          >
            {out
              ? `Out until ${formatAt(next.at, timestampFormat, now)}`
              : `+${next.restoresPercent}% at ${formatAt(next.at, timestampFormat, now)}`}
          </span>
        ) : null}
      </div>
      {runway ? <RunwayChart runway={runway} color={color} now={now} label={label} /> : null}
    </Card>
  );
}

export function RunwayCard({
  pool,
  runway,
  label,
  description,
  accounts,
  color,
  now,
}: {
  readonly pool: LimitPoolWindow;
  readonly runway: LimitRunway;
  readonly label: string;
  readonly description: string | undefined;
  /** Each account's own reading, under the pooled figure. */
  readonly accounts?: ReactNode;
  readonly color: string;
  readonly now: number;
}) {
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const at = (time: number) => formatAt(time, timestampFormat, now);
  const { burnPerDay: burn, safe, pace } = runway;
  const empty = pool.remainingPercent === 0;
  const fast = pace === "ahead";
  return (
    <Card description={description} accounts={accounts}>
      <div className="flex flex-col gap-1">
        <Headline label={label} remaining={pool.remainingPercent} />
        {empty && runway.refills[0] ? (
          <span className="mt-1 text-sm font-medium text-warning">
            Out until {at(runway.refills[0].at)}
          </span>
        ) : pace ? (
          <span className={cn("mt-1 text-sm font-medium", PACE[pace].className)}>
            {PACE[pace].label}
          </span>
        ) : null}
        {!empty && (burn !== null || safe) ? (
          <span className="text-xs text-muted-foreground tabular-nums">
            {burn !== null ? (
              <span className="block">
                Using <span className="font-medium text-foreground">{formatRate(burn)}/day</span>
              </span>
            ) : null}
            {safe ? (
              <span className="block">
                {fast ? "Stay under " : "Up to "}
                <span className="font-medium text-foreground">{formatRate(safe.perDay)}/day</span>
                {fast ? " until " : " lasts until "}
                {at(safe.until)}
              </span>
            ) : null}
          </span>
        ) : null}
      </div>
      <RunwayChart runway={runway} color={color} now={now} label={label} />
    </Card>
  );
}

function RunwayChart({
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
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const span = runway.to - runway.from;
  const x = (at: number) =>
    ((Math.min(Math.max(at, runway.from), runway.to) - runway.from) / span) * 100;
  const y = (remaining: number) => 100 - Math.min(Math.max(remaining, 0), 100);
  const line = (points: readonly RunwayPoint[]) =>
    points.map((point) => `${x(point.at)},${y(point.remaining)}`).join(" ");
  const area = (points: readonly RunwayPoint[]) =>
    points.length > 0 ? `${x(points[0]!.at)},100 ${line(points)} ${x(points.at(-1)!.at)},100` : "";
  const refillTops = runway.refills.map((refill) => ({
    ...refill,
    top: runway.projection.findLast((point) => point.at === refill.at)?.remaining ?? 0,
  }));
  const ticks = axisTicks(runway.from, runway.to, timestampFormat);
  const out = runway.out;
  return (
    <div
      role="img"
      aria-label={`${label} quota over time${
        out ? `, runs out ${formatAt(out.at, timestampFormat, now)} at this rate` : ""
      }`}
      className="min-w-0 pt-8"
    >
      <div className="relative h-28">
        <div className="absolute inset-x-0 top-0 border-t border-dashed border-border/70" />
        {out && out.at < runway.to ? (
          <>
            <div
              className="absolute inset-y-0 text-warning opacity-40"
              style={{
                left: `${x(out.at)}%`,
                width: `${x(out.until) - x(out.at)}%`,
                backgroundImage:
                  "repeating-linear-gradient(135deg, currentColor 0 1.5px, transparent 1.5px 6px)",
              }}
            />
            <span
              className={cn(
                "absolute top-0.5 text-2xs font-medium whitespace-nowrap text-warning",
                // Too close to now, the label would run over the now marker, so it goes inside the band.
                x(out.at) - x(now) < 25 ? "ps-1.5" : "-translate-x-full pe-1.5",
              )}
              style={{ left: `${x(out.at)}%` }}
            >
              out {formatAt(out.at, timestampFormat, now)}
            </span>
          </>
        ) : null}
        <svg
          aria-hidden
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          className="absolute inset-0 size-full overflow-visible"
        >
          {runway.past.map((stretch) => (
            <g key={stretch[0]!.at}>
              <polygon points={area(stretch)} fill={color} fillOpacity={0.3} />
              <polyline
                points={line(stretch)}
                fill="none"
                stroke={color}
                strokeWidth={2}
                vectorEffect="non-scaling-stroke"
              />
            </g>
          ))}
          <polygon points={area(runway.projection)} fill={color} fillOpacity={0.1} />
          <polyline
            points={line(runway.projection)}
            fill="none"
            stroke={color}
            strokeWidth={1.5}
            strokeDasharray="4 3"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
        <div className="absolute inset-x-0 bottom-0 border-b border-border" />
        <div
          className="absolute -top-3.5 bottom-0 w-px bg-foreground/70"
          style={{ left: `${x(now)}%` }}
        />
        <span
          className="absolute -top-4 -translate-x-1/2 -translate-y-full text-2xs font-semibold text-foreground"
          style={{ left: `${x(now)}%` }}
        >
          now
        </span>
        {refillTops.map((refill) => (
          <span
            key={refill.at}
            className="absolute -translate-x-1/2 -translate-y-full pb-0.5 text-2xs font-semibold text-foreground tabular-nums"
            style={{ left: `${x(refill.at)}%`, top: `${y(refill.top)}%` }}
          >
            +{Math.round(refill.percent)}%
          </span>
        ))}
      </div>
      <div className="relative mt-1 h-4">
        {ticks.map((tick) => (
          <span
            key={tick.at}
            className="absolute -translate-x-1/2 text-2xs whitespace-nowrap text-muted-foreground"
            style={{ left: `${x(tick.at)}%` }}
          >
            {tick.label}
          </span>
        ))}
      </div>
    </div>
  );
}

/** Hours for spans under a day, weekday names centred on each day, or a date each week beyond. */
function axisTicks(from: number, to: number, timestampFormat: TimestampFormat) {
  if (to - from < DAY) {
    const step = to - from <= 12 * HOUR ? 2 * HOUR : 4 * HOUR;
    const hourFormatter = new Intl.DateTimeFormat(undefined, {
      hour: "numeric",
      ...(timestampFormat === "locale" ? {} : { hour12: timestampFormat === "12-hour" }),
    });
    const ticks: Array<{ at: number; label: string }> = [];
    for (let at = startOfDay(from); at < to; at += step) {
      if (at > from) ticks.push({ at, label: hourFormatter.format(at) });
    }
    return ticks;
  }
  const weekly = to - from <= 10 * DAY;
  const ticks: Array<{ at: number; label: string }> = [];
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
