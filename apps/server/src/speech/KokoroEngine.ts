import * as NodeModule from "node:module";

import { sha256 } from "@noble/hashes/sha2";
import type { ReadAloudVoice } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Base64 from "effect/encoding/Base64";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as Queue from "effect/Queue";
import * as RcRef from "effect/RcRef";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import { KOKORO_ENGINE_SCRIPT } from "./kokoroEngineScript.ts";

export class SpeechModelDownloadError extends Schema.TaggedError<SpeechModelDownloadError>()(
  "SpeechModelDownloadError",
  {
    file: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to download speech model file ${this.file}.`;
  }
}

const isSpeechModelDownloadError = Schema.is(SpeechModelDownloadError);

export class SpeechEngineError extends Schema.TaggedError<SpeechEngineError>()(
  "SpeechEngineError",
  {
    operation: Schema.Literals(["start", "phonemize", "infer"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `The speech engine failed to ${this.operation}.`;
  }
}

/** A running engine, valid for the scope it was acquired in. */
interface KokoroSession {
  readonly vocab: ReadonlyMap<string, number>;
  readonly phonemize: (
    text: string,
    language: "en-us" | "en",
  ) => Effect.Effect<ReadonlyArray<string>, SpeechEngineError>;
  /** Returns 24 kHz mono samples for boundary-wrapped token ids. */
  readonly infer: (ids: ReadonlyArray<number>) => Effect.Effect<Float32Array, SpeechEngineError>;
}

export class KokoroEngine extends Context.Service<
  KokoroEngine,
  {
    /**
     * Downloads the model on first use, then starts the engine process or reuses a
     * running one. The process exits once no scope has used it for five minutes.
     */
    readonly acquire: (input: {
      readonly voice: ReadAloudVoice;
      readonly onDownloadProgress: (completed: number, total: number | null) => Effect.Effect<void>;
    }) => Effect.Effect<KokoroSession, SpeechModelDownloadError | SpeechEngineError, Scope.Scope>;
  }
>()("t3/speech/KokoroEngine") {}

// Pinned so every host speaks with the same model the text pipeline was verified against.
const KOKORO_REPOSITORY = "onnx-community/Kokoro-82M-v1.0-ONNX";
const KOKORO_REVISION = "1939ad2a8e416c0acfeecc08a694d14ef25f2231";
// fp32 runs about twice as fast as the 8-bit model on CPU, at 326 MB instead of 92 MB.
const MODEL_FILE = {
  path: "onnx/model.onnx",
  sha256: "8fbea51ea711f2af382e88c833d9e288c6dc82ce5e98421ea61c058ce21a34cb",
};
const ENGINE_IDLE_TIME = Duration.minutes(5);
const DOWNLOAD_RESPONSE_TIMEOUT = Duration.seconds(30);

// The engine process loads these from disk, so they stay external to the server bundle.
const requireForEngine = NodeModule.createRequire(import.meta.url);

const TokenizerJson = Schema.fromJsonString(
  Schema.Struct({ model: Schema.Struct({ vocab: Schema.Record(Schema.String, Schema.Number) }) }),
);
const EngineConfigJson = Schema.fromJsonString(
  Schema.Struct({
    onnxRuntimePath: Schema.String,
    phonemizerPath: Schema.String,
    modelPath: Schema.String,
  }),
);
const EngineRequestJson = Schema.fromJsonString(
  Schema.Union([
    Schema.Struct({
      id: Schema.Number,
      op: Schema.Literal("phonemize"),
      text: Schema.String,
      language: Schema.String,
    }),
    Schema.Struct({
      id: Schema.Number,
      op: Schema.Literal("infer"),
      ids: Schema.Array(Schema.Number),
      voicePath: Schema.String,
    }),
  ]),
);
type EngineRequest = typeof EngineRequestJson.Type;
const EngineResponseJson = Schema.fromJsonString(
  Schema.Struct({
    id: Schema.Number,
    error: Schema.optionalKey(Schema.String),
    phonemes: Schema.optionalKey(Schema.Array(Schema.String)),
    audio: Schema.optionalKey(Schema.String),
  }),
);
type EngineResponse = typeof EngineResponseJson.Type;
const encodeEngineConfig = Schema.encodeEffect(EngineConfigJson);
const encodeEngineRequest = Schema.encodeEffect(EngineRequestJson);
const decodeEngineResponse = Schema.decodeEffect(EngineResponseJson);
const decodeTokenizer = Schema.decodeEffect(TokenizerJson);

class EngineFailure extends Schema.TaggedError<EngineFailure>()("EngineFailure", {
  reason: Schema.String,
}) {}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const httpClient = yield* HttpClient.HttpClient;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const root = path.join(config.providerStatusCacheDir, "kokoro", KOKORO_REVISION);
  const encoder = new TextEncoder();

  /** Downloads a model file into the cache once, verifying it when a hash is pinned. */
  const ensureFile = Effect.fn("KokoroEngine.ensureFile")(function* (
    file: string,
    options: {
      readonly sha256?: string;
      readonly onProgress?: (completed: number, total: number | null) => Effect.Effect<void>;
    } = {},
  ) {
    const target = path.join(root, file);
    if (yield* fileSystem.exists(target).pipe(Effect.orElseSucceed(() => false))) return target;
    const fail = (cause?: unknown) => new SpeechModelDownloadError({ file, cause });
    return yield* Effect.scoped(
      Effect.gen(function* () {
        yield* fileSystem.makeDirectory(path.dirname(target), { recursive: true });
        // Same directory as the target, so the final rename never crosses filesystems.
        const temporaryDirectory = yield* fileSystem.makeTempDirectoryScoped({
          directory: path.dirname(target),
          prefix: ".download-",
        });
        const temporaryFile = path.join(temporaryDirectory, path.basename(target));
        const response = yield* httpClient
          .execute(
            HttpClientRequest.get(
              `https://huggingface.co/${KOKORO_REPOSITORY}/resolve/${KOKORO_REVISION}/${file}`,
            ),
          )
          .pipe(
            Effect.flatMap(HttpClientResponse.filterStatusOk),
            Effect.timeout(DOWNLOAD_RESPONSE_TIMEOUT),
          );
        const length = Number(response.headers["content-length"]);
        const total = Number.isFinite(length) && length > 0 ? length : null;
        const hash = options.sha256 === undefined ? undefined : sha256.create();
        let completed = 0;
        let reportedPercent = -1;
        yield* response.stream.pipe(
          Stream.tap((chunk) => {
            completed += chunk.byteLength;
            hash?.update(chunk);
            const onProgress = options.onProgress;
            if (onProgress === undefined || total === null) return Effect.void;
            // At most one update per percent, so the client is not flooded.
            const percent = Math.floor((completed / total) * 100);
            if (percent === reportedPercent) return Effect.void;
            reportedPercent = percent;
            return onProgress(completed, total);
          }),
          Stream.run(fileSystem.sink(temporaryFile)),
        );
        if (hash !== undefined && Hex.encode(hash.digest()) !== options.sha256) {
          return yield* fail();
        }
        yield* fileSystem.rename(temporaryFile, target);
        return target;
      }),
    ).pipe(Effect.mapError((cause) => (isSpeechModelDownloadError(cause) ? cause : fail(cause))));
  });

  const startEngine = Effect.gen(function* () {
    const start = (cause?: unknown) => new SpeechEngineError({ operation: "start", cause });
    const engineConfig = yield* Effect.try({
      try: () => ({
        onnxRuntimePath: requireForEngine.resolve("onnxruntime-node"),
        phonemizerPath: requireForEngine.resolve("phonemizer"),
        modelPath: path.join(root, MODEL_FILE.path),
      }),
      catch: start,
    });
    const configJson = yield* encodeEngineConfig(engineConfig).pipe(Effect.mapError(start));
    const handle = yield* spawner
      .spawn(
        // The server's own Node runs the engine. In the desktop app that is Electron, which
        // behaves as Node because the server inherits ELECTRON_RUN_AS_NODE.
        ChildProcess.make(process.execPath, ["-e", KOKORO_ENGINE_SCRIPT], {
          env: { T3_KOKORO_ENGINE_CONFIG: configJson },
          extendEnv: true,
        }),
      )
      .pipe(Effect.mapError(start));

    const requests = yield* Queue.unbounded<Uint8Array, Cause.Done>();
    yield* Stream.fromQueue(requests).pipe(
      Stream.run(handle.stdin),
      Effect.ignore,
      Effect.forkScoped,
    );
    const responses = yield* Queue.unbounded<EngineResponse, EngineFailure | Cause.Done>();
    yield* handle.stdout.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.mapEffect((line) => decodeEngineResponse(line)),
      Stream.mapError(() => new EngineFailure({ reason: "unreadable output" })),
      Stream.runIntoQueue(responses),
      Effect.forkScoped,
    );
    yield* Stream.runDrain(handle.stderr).pipe(Effect.ignore, Effect.forkScoped);

    // Takes responses until the one for `id`, skipping answers to interrupted requests.
    const awaitResponse = (id: number) =>
      Effect.gen(function* () {
        while (true) {
          const response = yield* Queue.take(responses).pipe(
            Effect.catchTags({ Done: () => new EngineFailure({ reason: "exited" }) }),
          );
          if (response.id !== id) continue;
          if (response.error !== undefined) {
            return yield* new EngineFailure({ reason: response.error });
          }
          return response;
        }
      });

    yield* awaitResponse(0).pipe(Effect.mapError(start));

    const lock = yield* Semaphore.make(1);
    let nextId = 0;
    const call = (request: (id: number) => EngineRequest) =>
      lock.withPermit(
        Effect.gen(function* () {
          const id = ++nextId;
          const line = yield* encodeEngineRequest(request(id));
          yield* Queue.offer(requests, encoder.encode(`${line}\n`));
          return yield* awaitResponse(id);
        }),
      );
    return { call };
  });

  const engine = yield* RcRef.make({ acquire: startEngine, idleTimeToLive: ENGINE_IDLE_TIME });

  const acquire: KokoroEngine["Service"]["acquire"] = ({ voice, onDownloadProgress }) =>
    Effect.gen(function* () {
      yield* ensureFile(MODEL_FILE.path, {
        sha256: MODEL_FILE.sha256,
        onProgress: onDownloadProgress,
      });
      const tokenizerPath = yield* ensureFile("tokenizer.json");
      const voicePath = yield* ensureFile(`voices/${voice}.bin`);
      const tokenizer = yield* fileSystem.readFileString(tokenizerPath).pipe(
        Effect.flatMap(decodeTokenizer),
        Effect.mapError((cause) => new SpeechModelDownloadError({ file: "tokenizer.json", cause })),
      );
      const running = yield* RcRef.get(engine);
      // A failed engine is replaced on the next request rather than reused.
      const failed = (operation: SpeechEngineError["operation"]) => (cause: unknown) =>
        RcRef.invalidate(engine).pipe(
          Effect.andThen(Effect.fail(new SpeechEngineError({ operation, cause }))),
        );
      return {
        vocab: new Map(Object.entries(tokenizer.model.vocab)),
        phonemize: (text, language) =>
          running
            .call((id) => ({ id, op: "phonemize", text, language }))
            .pipe(
              Effect.map((response) => response.phonemes ?? []),
              Effect.catch(failed("phonemize")),
            ),
        infer: (ids) =>
          running
            .call((id) => ({ id, op: "infer", ids: [...ids], voicePath }))
            .pipe(
              Effect.flatMap((response) => {
                const bytes = Base64.decode(response.audio ?? "");
                return Result.isSuccess(bytes)
                  ? Effect.succeed(new Float32Array(bytes.success.slice().buffer))
                  : Effect.fail(bytes.failure);
              }),
              Effect.catch(failed("infer")),
            ),
      } satisfies KokoroSession;
    });

  return KokoroEngine.of({ acquire });
});

export const layer = Layer.effect(KokoroEngine, make);
