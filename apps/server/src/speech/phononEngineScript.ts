// Runs blocking WebAssembly inference off the server's event loop, speaking JSON lines on
// stdout (console goes to stderr; id 0 means ready; closing stdin exits). phonon-tts's
// threaded build targets browsers: rayon starts Web Workers and listens on `self`, so
// `installWebWorkers` maps both onto worker_threads here and in every worker.
export const PHONON_ENGINE_SCRIPT = String.raw`
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const readline = require("node:readline");

function installWebWorkers(workerSource) {
  const { Worker: NodeWorker, parentPort } = require("node:worker_threads");
  console.log = console.info = console.debug = console.error;
  class WebWorker extends EventTarget {
    constructor(url) {
      super();
      this.worker = new NodeWorker(workerSource, {
        eval: true,
        workerData: { url: String(url), source: workerSource },
      });
      this.worker.on("message", (data) => this.dispatchEvent(new MessageEvent("message", { data })));
      this.worker.on("error", (error) => {
        console.error(error);
        this.dispatchEvent(new Event("error"));
      });
    }
    postMessage(data) {
      this.worker.postMessage(data);
    }
    terminate() {
      return this.worker.terminate();
    }
  }
  globalThis.Worker = WebWorker;
  globalThis.self = new EventTarget();
  if (parentPort) {
    globalThis.postMessage = (data) => parentPort.postMessage(data);
    parentPort.on("message", (data) => self.dispatchEvent(new MessageEvent("message", { data })));
  }
}
const WORKER_SOURCE =
  installWebWorkers.toString() +
  "\nconst { workerData } = require('node:worker_threads');" +
  "\ninstallWebWorkers(workerData.source);" +
  "\nimport(workerData.url);";
installWebWorkers(WORKER_SOURCE);

const config = JSON.parse(process.env.T3_PHONON_ENGINE_CONFIG);
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const describe = (error) => String((error && error.message) || error);

// Three threads is phonon-tts's own default; half the host leaves room for agents.
const cpus = typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length;
const threads = Math.max(2, Math.min(3, Math.floor(cpus / 2)));
// The Python and command-line runtimes' defaults, so every host speaks the same way.
const TEMPERATURE = 0.3;
const SEED = 4242424242424242n;

const load = async () => {
  const phonon = await import(config.moduleUrl);
  await phonon.default({ module_or_path: await WebAssembly.compile(fs.readFileSync(config.wasmPath)) });
  await phonon.initThreadPool(threads - 1);
  phonon.start_cpu_pool(threads - 1);
  return phonon.Model.load(
    fs.readFileSync(config.modelPath),
    fs.readFileSync(config.tokenizerPath),
    fs.readFileSync(config.configPath),
    "q8",
    "en",
    null,
    null,
    "cpu",
  );
};
const model = load();
model.then(
  () => send({ id: 0 }),
  (error) => send({ id: 0, error: describe(error) }),
);

const voices = new Map();
const speak = async (text, voicePath) => {
  const loaded = await model;
  let voice = voices.get(voicePath);
  if (voice === undefined) {
    voice = loaded.add_voice(fs.readFileSync(voicePath));
    voices.set(voicePath, voice);
  }
  loaded.start_generation(voice, text, TEMPERATURE, SEED);
  const frames = [];
  let length = 0;
  while (loaded.next_chunk() !== undefined) {
    for (;;) {
      const frame = await loaded.generation_step();
      if (frame === undefined) break;
      frames.push(frame);
      length += frame.length;
    }
  }
  const audio = new Float32Array(length);
  let offset = 0;
  for (const frame of frames) {
    audio.set(frame, offset);
    offset += frame.length;
  }
  return { audio: Buffer.from(audio.buffer).toString("base64") };
};

let queue = Promise.resolve();
readline
  .createInterface({ input: process.stdin })
  .on("line", (line) => {
    const request = JSON.parse(line);
    queue = queue
      .then(() => speak(request.text, request.voicePath))
      .then(
        (result) => send({ id: request.id, ...result }),
        (error) => send({ id: request.id, error: describe(error) }),
      );
  })
  .on("close", () => queue.finally(() => process.exit(0)));
`;
