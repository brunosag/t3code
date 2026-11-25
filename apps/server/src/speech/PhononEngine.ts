import * as NodeModule from "node:module";
import * as NodeURL from "node:url";

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
import { PHONON_ENGINE_SCRIPT } from "./phononEngineScript.ts";

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
    operation: Schema.Literals(["start", "speak"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `The speech engine failed to ${this.operation}.`;
  }
}

/** A running engine, valid for the scope it was acquired in. */
interface PhononSession {
  /** Returns 24 kHz mono samples for `text` in the acquired voice. */
  readonly speak: (text: string) => Effect.Effect<Float32Array, SpeechEngineError>;
}

export class PhononEngine extends Context.Service<
  PhononEngine,
  {
    /**
     * Downloads the model and voice on first use, then starts the engine process or reuses
     * a running one. The process exits once no scope has used it for five minutes.
     */
    readonly acquire: (input: {
      readonly voice: ReadAloudVoice;
      readonly onDownloadProgress: (completed: number, total: number | null) => Effect.Effect<void>;
    }) => Effect.Effect<PhononSession, SpeechModelDownloadError | SpeechEngineError, Scope.Scope>;
  }
>()("t3/speech/PhononEngine") {}

interface RemoteFile {
  readonly repository: string;
  readonly revision: string;
  readonly path: string;
  readonly sha256?: string;
}

// Pinned so every host speaks with the same model and voices the text pipeline was checked with.
const MODEL_REPOSITORY = "gradium/phonon-31m-en";
const MODEL_REVISION = "92741c5b07d085ff840e26fea8ce43110b87852f";
const modelFile = (path: string, hash: string): RemoteFile => ({
  repository: MODEL_REPOSITORY,
  revision: MODEL_REVISION,
  path,
  sha256: hash,
});
const MODEL_FILES = {
  // The q8 weights run as fast as f32 in WebAssembly, at 64 MB instead of 103 MB.
  model: modelFile(
    "model.q8.gguf",
    "a7d9aad2cd6dc66473f24a08bc6d2939030ef4d751ef82349361fbef3272dbae",
  ),
  tokenizer: modelFile(
    "tokenizer.json",
    "691a00068fa7b989f2f3e5ae5daa2d1a5bb319f2d5360deafcfb19a8bb6e7936",
  ),
  config: modelFile(
    "config.json",
    "b5d0f88353638370d94035b7d73d7d6577c0554d78f8d7ecfd40490aae39ae85",
  ),
};
const DEFAULT_VOICE = modelFile(
  "default-voice.safetensors",
  "dc537478eaadc1a5257fcda2e3501ab81e14c111a5d95a5838f350db2afd0f1a",
);
const VOICE_REPOSITORY = "gradium/phonon-voices";
const VOICE_REVISION = "da6c9ec0d47be8df5c87c730a3aa97187f3229c3";
/** Changes whenever the same text and voice could sound different. */
export const SPEECH_ENGINE_REVISION = `${MODEL_REVISION}/${VOICE_REVISION}`;
// Catalog ids of the voices offered by name, from the catalog's voices.jsonl.
const CATALOG_VOICE_IDS: Record<Exclude<ReadAloudVoice, "default">, string> = {
  zoey: "NbpkqMVS3CJeq2j8",
  juniper: "NIWIOv5vTi5eRMj8",
  everly: "vjFyp2BcCyTlUmYb",
  harper: "4SZHfMpw-p46Ywgs",
  hadley: "bXwrkHhURL1VFJdG",
  delia: "nGzMHMPAWGaJFHOo",
  easton: "LMDIYE0Oa377Qh6Z",
  micah: "40QrMVgAxFiUnP9f",
  trevor: "0zLApsZfVLLNaEGl",
  russell: "_6Aslh2DxfmnRLmP",
  preston: "qIxlZ7Ei8KvWlyQH",
  miles: "d9XCyhjo4JhkHF1d",
  maeve: "6PWnV0Nq4wu7RVBT",
  freya: "GgfEkEJtxZR7gnpy",
  pippa: "uem82D50GRv2Dwma",
  "elodie-rose": "y9bQqIDnyxwqK01t",
  imogen: "gDT1nz7Ie36ZhL-C",
  lottie: "m9MxpY6IUGXtWp76",
  bryony: "gfP44RlHwr2kEwk7",
  alfie: "X6NceqF285Gr04gb",
  hugh: "YyKcxPG7iIgS3jsK",
  edwin: "zUCxzrOrugTSis03",
  spencer: "JOW0vchyswkQUMDS",
  toby: "dME3IWyZBvmh1n1q",
  teddy: "Zn7g6NxLqXlJb7Qi",
};
const voiceFile = (voice: ReadAloudVoice): RemoteFile =>
  voice === "default"
    ? DEFAULT_VOICE
    : {
        repository: VOICE_REPOSITORY,
        revision: VOICE_REVISION,
        path: `voices/${CATALOG_VOICE_IDS[voice]}.safetensors`,
      };

const ENGINE_IDLE_TIME = Duration.minutes(5);
const DOWNLOAD_RESPONSE_TIMEOUT = Duration.seconds(30);

// The engine process loads phonon-tts from disk, so it stays external to the server bundle.
const requireForEngine = NodeModule.createRequire(import.meta.url);

const EngineConfigJson = Schema.fromJsonString(
  Schema.Struct({
    moduleUrl: Schema.String,
    wasmPath: Schema.String,
    modelPath: Schema.String,
    tokenizerPath: Schema.String,
    configPath: Schema.String,
  }),
);
const EngineRequestJson = Schema.fromJsonString(
  Schema.Struct({ id: Schema.Number, text: Schema.String, voicePath: Schema.String }),
);
type EngineRequest = typeof EngineRequestJson.Type;
const EngineResponseJson = Schema.fromJsonString(
  Schema.Struct({
    id: Schema.Number,
    error: Schema.optionalKey(Schema.String),
    audio: Schema.optionalKey(Schema.String),
  }),
);
type EngineResponse = typeof EngineResponseJson.Type;
const encodeEngineConfig = Schema.encodeEffect(EngineConfigJson);
const encodeEngineRequest = Schema.encodeEffect(EngineRequestJson);
const decodeEngineResponse = Schema.decodeEffect(EngineResponseJson);

class EngineFailure extends Schema.TaggedError<EngineFailure>()("EngineFailure", {
  reason: Schema.String,
}) {}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const httpClient = yield* HttpClient.HttpClient;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const root = path.join(config.providerStatusCacheDir, "phonon");
  const encoder = new TextEncoder();

  const localPath = (file: RemoteFile) =>
    path.join(root, file.repository.replace("/", "--"), file.revision, file.path);

  /** Downloads a file into the cache once, verifying it when a hash is pinned. */
  const ensureFile = Effect.fn("PhononEngine.ensureFile")(function* (
    file: RemoteFile,
    onProgress?: (completed: number, total: number | null) => Effect.Effect<void>,
  ) {
    const target = localPath(file);
    if (yield* fileSystem.exists(target).pipe(Effect.orElseSucceed(() => false))) return target;
    const fail = (cause?: unknown) => new SpeechModelDownloadError({ file: file.path, cause });
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
              `https://huggingface.co/${file.repository}/resolve/${file.revision}/${file.path}`,
            ),
          )
          .pipe(
            Effect.flatMap(HttpClientResponse.filterStatusOk),
            Effect.timeout(DOWNLOAD_RESPONSE_TIMEOUT),
          );
        const length = Number(response.headers["content-length"]);
        const total = Number.isFinite(length) && length > 0 ? length : null;
        const hash = file.sha256 === undefined ? undefined : sha256.create();
        let completed = 0;
        let reportedPercent = -1;
        yield* response.stream.pipe(
          Stream.tap((chunk) => {
            completed += chunk.byteLength;
            hash?.update(chunk);
            if (onProgress === undefined || total === null) return Effect.void;
            // At most one update per percent, so the client is not flooded.
            const percent = Math.floor((completed / total) * 100);
            if (percent === reportedPercent) return Effect.void;
            reportedPercent = percent;
            return onProgress(completed, total);
          }),
          Stream.run(fileSystem.sink(temporaryFile)),
        );
        if (hash !== undefined && Hex.encode(hash.digest()) !== file.sha256) {
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
      try: () => {
        const packageRoot = path.dirname(requireForEngine.resolve("phonon-tts/package.json"));
        return {
          // The threaded build; its JavaScript is not in the package's exports map.
          moduleUrl: NodeURL.pathToFileURL(path.join(packageRoot, "wasm-threads/phonon_tts.js"))
            .href,
          wasmPath: path.join(packageRoot, "wasm-threads/phonon_tts_simd_bg.wasm"),
          modelPath: localPath(MODEL_FILES.model),
          tokenizerPath: localPath(MODEL_FILES.tokenizer),
          configPath: localPath(MODEL_FILES.config),
        };
      },
      catch: start,
    });
    const configJson = yield* encodeEngineConfig(engineConfig).pipe(Effect.mapError(start));
    const handle = yield* spawner
      .spawn(
        // The server's own Node runs the engine. In the desktop app that is Electron, which
        // behaves as Node because the server inherits ELECTRON_RUN_AS_NODE.
        ChildProcess.make(process.execPath, ["-e", PHONON_ENGINE_SCRIPT], {
          env: { T3_PHONON_ENGINE_CONFIG: configJson },
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
    const awaitResponse = Effect.fn("PhononEngine.awaitResponse")(function* (id: number) {
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

  const acquire: PhononEngine["Service"]["acquire"] = Effect.fn("PhononEngine.acquire")(function* ({
    voice,
    onDownloadProgress,
  }) {
    // The weights are nearly all of the download, so only they report progress.
    yield* ensureFile(MODEL_FILES.model, onDownloadProgress);
    yield* ensureFile(MODEL_FILES.tokenizer);
    yield* ensureFile(MODEL_FILES.config);
    const voicePath = yield* ensureFile(voiceFile(voice));
    const running = yield* RcRef.get(engine);
    return {
      speak: (text) =>
        running
          .call((id) => ({ id, text, voicePath }))
          .pipe(
            Effect.flatMap((response) => {
              const bytes = Base64.decode(response.audio ?? "");
              return Result.isSuccess(bytes)
                ? Effect.succeed(new Float32Array(bytes.success.slice().buffer))
                : Effect.fail(bytes.failure);
            }),
            // A failed engine is replaced on the next request rather than reused.
            Effect.catch((cause) =>
              RcRef.invalidate(engine).pipe(
                Effect.andThen(Effect.fail(new SpeechEngineError({ operation: "speak", cause }))),
              ),
            ),
          ),
    } satisfies PhononSession;
  });

  return PhononEngine.of({ acquire });
});

export const layer = Layer.effect(PhononEngine, make);
