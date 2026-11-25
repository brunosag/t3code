// @effect-diagnostics-next-line nodeBuiltinImport:off -- A synchronous digest names each entry.
import * as NodeCrypto from "node:crypto";

import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";

/** About three hours of speech; past it the least recently read entries go first. */
const SPEECH_CACHE_BUDGET_BYTES = 512 * 1024 * 1024;

export class SpeechCache extends Context.Service<
  SpeechCache,
  {
    /** What was saved under `key`, or null. A cache that can't be read is a miss. */
    readonly get: (key: ReadonlyArray<unknown>) => Effect.Effect<Uint8Array | null>;
    /** Saves `bytes` under `key`. A failed write is dropped: the cache is never worth an error. */
    readonly set: (key: ReadonlyArray<unknown>, bytes: Uint8Array) => Effect.Effect<void>;
  }
>()("t3/speech/SpeechCache") {}

export const makeAt = Effect.fn("SpeechCache.makeAt")(function* (
  directory: string,
  budgetBytes = SPEECH_CACHE_BUDGET_BYTES,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const fileOf = (key: ReadonlyArray<unknown>) =>
    path.join(directory, NodeCrypto.createHash("sha256").update(JSON.stringify(key)).digest("hex"));
  // Unknown until the first write scans the directory.
  let totalBytes: number | null = null;

  const prune = Effect.gen(function* () {
    const names = yield* fileSystem.readDirectory(directory);
    const entries = yield* Effect.forEach(names, (name) => {
      const file = path.join(directory, name);
      return fileSystem.stat(file).pipe(
        Effect.map((info) => ({
          file,
          size: Number(info.size),
          readAt: Option.match(info.mtime, { onNone: () => 0, onSome: (date) => date.getTime() }),
        })),
        Effect.option,
      );
    });
    const files = entries.flatMap((entry) => (Option.isSome(entry) ? [entry.value] : []));
    let total = files.reduce((sum, entry) => sum + entry.size, 0);
    if (total > budgetBytes) {
      // Well below the budget, so a full cache isn't rescanned on every write.
      const target = budgetBytes * 0.75;
      for (const entry of files.toSorted((a, b) => a.readAt - b.readAt)) {
        if (total <= target) break;
        yield* fileSystem.remove(entry.file, { force: true }).pipe(Effect.ignore);
        total -= entry.size;
      }
    }
    totalBytes = total;
  });

  return SpeechCache.of({
    get: Effect.fn("SpeechCache.get")(function* (key) {
      const file = fileOf(key);
      return yield* fileSystem.readFile(file).pipe(
        // Node hands back a Buffer; callers get the same plain bytes freshly made audio is.
        Effect.map((bytes) => new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)),
        // Reading marks the entry recently used, which is what pruning goes by.
        Effect.tap(() =>
          DateTime.now.pipe(
            Effect.map(DateTime.toDate),
            Effect.flatMap((now) => fileSystem.utimes(file, now, now)),
            Effect.ignore,
          ),
        ),
        Effect.orElseSucceed(() => null),
      );
    }),
    set: Effect.fn("SpeechCache.set")(
      function* (key, bytes) {
        const file = fileOf(key);
        // Written whole and renamed into place, so a reader never sees half an entry.
        const temporary = `${file}.${NodeCrypto.randomUUID()}.tmp`;
        yield* fileSystem.makeDirectory(directory, { recursive: true });
        yield* fileSystem.writeFile(temporary, bytes);
        yield* fileSystem
          .rename(temporary, file)
          .pipe(Effect.tapError(() => Effect.ignore(fileSystem.remove(temporary))));
        if (totalBytes !== null) totalBytes += bytes.byteLength;
        if (totalBytes === null || totalBytes > budgetBytes) yield* prune;
      },
      Effect.catchCause((cause) => Effect.logWarning("Couldn't save speech to the cache", cause)),
    ),
  });
});

export const layer = Layer.effect(
  SpeechCache,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const path = yield* Path.Path;
    return yield* makeAt(path.join(config.providerStatusCacheDir, "speech"));
  }),
);
