import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import * as SpeechCache from "./SpeechCache.ts";

const bytes = (fill: number) => new Uint8Array(100).fill(fill);

describe("SpeechCache", () => {
  it.live("drops the least recently read entries once past its budget", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped();
      const cache = yield* SpeechCache.makeAt(directory, 300);
      yield* cache.set(["a"], bytes(1));
      yield* cache.set(["b"], bytes(2));
      yield* cache.set(["c"], bytes(3));
      // Written within the same instant, so all three are made equally old first.
      for (const name of yield* fs.readDirectory(directory)) {
        yield* fs.utimes(`${directory}/${name}`, 0, 0);
      }
      expect(yield* cache.get(["a"])).toEqual(bytes(1));
      yield* cache.set(["d"], bytes(4));
      expect(yield* cache.get(["a"])).toEqual(bytes(1));
      expect(yield* cache.get(["b"])).toBeNull();
      expect(yield* cache.get(["c"])).toBeNull();
      expect(yield* cache.get(["d"])).toEqual(bytes(4));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("misses a key it never saved", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cache = yield* SpeechCache.makeAt(yield* fs.makeTempDirectoryScoped());
      expect(yield* cache.get(["audio", "missing"])).toBeNull();
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
