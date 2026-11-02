import type { UsageLimitSourceSnapshot } from "@t3tools/contracts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";

const HOUR = 3_600_000;
// Burn is read over the last day against the reading a day before it, so keep two.
const KEEP_HOURS = 48;
const MIN_WINDOW_MINS = 24 * 60;

/** Window key, then hour start (epoch ms), to the last usedPercent read in that hour. */
const Readings = Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Number));
type Readings = typeof Readings.Type;
const ReadingsJson = Schema.fromJsonString(Readings);
const decodeReadings = Schema.decodeUnknownOption(ReadingsJson);
const encodeReadings = Schema.encodeSync(ReadingsJson);

const windowKey = (sourceId: string, accountId: string, windowId: string) =>
  JSON.stringify([sourceId, accountId, windowId]);

function trackedWindows(snapshots: ReadonlyArray<UsageLimitSourceSnapshot>) {
  return snapshots.flatMap((source) =>
    source.accounts.flatMap((account) =>
      account.usageLimits.unavailable
        ? []
        : account.usageLimits.windows.flatMap((window) =>
            (window.windowDurationMins ?? 0) >= MIN_WINDOW_MINS
              ? [{ key: windowKey(source.id, account.id, window.id), window }]
              : [],
          ),
    ),
  );
}

export function recordReadings(
  readings: Readings,
  snapshots: ReadonlyArray<UsageLimitSourceSnapshot>,
  now: number,
): Readings {
  const hour = Math.floor(now / HOUR) * HOUR;
  const oldest = hour - (KEEP_HOURS - 1) * HOUR;
  const next: Record<string, Record<string, number>> = {};
  for (const [key, hours] of Object.entries(readings)) {
    const kept = Object.entries(hours).filter(([at]) => Number(at) >= oldest);
    if (kept.length > 0) next[key] = Object.fromEntries(kept);
  }
  for (const { key, window } of trackedWindows(snapshots)) {
    next[key] = { ...next[key], [hour]: window.usedPercent };
  }
  return next;
}

export function attachHistory(
  readings: Readings,
  snapshots: ReadonlyArray<UsageLimitSourceSnapshot>,
): ReadonlyArray<UsageLimitSourceSnapshot> {
  return snapshots.map((source) => ({
    ...source,
    accounts: source.accounts.map((account) => ({
      ...account,
      usageLimits: {
        ...account.usageLimits,
        windows: account.usageLimits.windows.map((window) => {
          const hours = readings[windowKey(source.id, account.id, window.id)];
          if ((window.windowDurationMins ?? 0) < MIN_WINDOW_MINS || !hours) return window;
          const starts = Object.keys(hours).map(Number);
          const first = Math.min(...starts);
          const count = (Math.max(...starts) - first) / HOUR + 1;
          return {
            ...window,
            history: {
              startsAt: DateTime.formatIso(DateTime.makeUnsafe(first)),
              usedPercent: Array.from({ length: count }, (_, i) => hours[first + i * HOUR] ?? null),
            },
          };
        }),
      },
    })),
  }));
}

export class UsageLimitHistory extends Context.Service<
  UsageLimitHistory,
  {
    /** Records each long window's reading and returns the snapshots with their recent history. */
    readonly annotate: (
      snapshots: ReadonlyArray<UsageLimitSourceSnapshot>,
    ) => Effect.Effect<ReadonlyArray<UsageLimitSourceSnapshot>>;
  }
>()("t3/usage/UsageLimitHistory") {}

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const config = yield* ServerConfig.ServerConfig;
  const filePath = path.join(config.stateDir, "usage-limit-history.json");
  const stored = yield* fileSystem.readFileString(filePath).pipe(Effect.option);
  const readingsRef = yield* Ref.make<Readings>(
    Option.getOrElse(Option.flatMap(stored, decodeReadings), () => ({})),
  );

  const annotate = Effect.fn("UsageLimitHistory.annotate")(function* (
    snapshots: ReadonlyArray<UsageLimitSourceSnapshot>,
  ) {
    const now = yield* Clock.currentTimeMillis;
    const previous = yield* Ref.get(readingsRef);
    const next = recordReadings(previous, snapshots, now);
    const contents = encodeReadings(next);
    if (contents !== encodeReadings(previous)) {
      yield* Ref.set(readingsRef, next);
      yield* writeFileStringAtomically({ filePath, contents }).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        Effect.provideService(HostProcess.Platform, platform),
        Effect.ignoreCause({ log: true }),
      );
    }
    return attachHistory(next, snapshots);
  });

  return { annotate } satisfies UsageLimitHistory["Service"];
});

export const layer = Layer.effect(UsageLimitHistory, make);
