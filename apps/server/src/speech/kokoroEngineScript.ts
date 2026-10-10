/**
 * Source of the speech engine process, run with `node -e` under the server's own Node
 * (Electron's, in the desktop app). It stays in a separate process because:
 *
 * - ONNX Runtime's Node binding runs inference synchronously on the calling thread, which
 *   would stall the server for seconds per sentence.
 * - The binding cannot be loaded a second time in one process, so idle release has to end
 *   the process rather than a worker thread.
 * - phonemizer's espeak-ng build installs process-wide `uncaughtException` and
 *   `unhandledRejection` handlers that rethrow.
 *
 * Protocol: one JSON object per line on stdin and stdout. The process answers
 * `{ id: 0 }` once the model is loaded, then each request in order, and exits when
 * stdin closes.
 */
export const KOKORO_ENGINE_SCRIPT = String.raw`
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const readline = require("node:readline");

const config = JSON.parse(process.env.T3_KOKORO_ENGINE_CONFIG);
const ort = require(config.onnxRuntimePath);
const { phonemize } = require(config.phonemizerPath);

const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const describe = (error) => String((error && error.message) || error);

// Four threads measured fastest for this model; half the host leaves room for agents.
const cpus = typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length;
const threads = Math.max(1, Math.min(4, Math.floor(cpus / 2)));
const session = ort.InferenceSession.create(config.modelPath, { intraOpNumThreads: threads });
session.then(
  () => send({ id: 0 }),
  (error) => send({ id: 0, error: describe(error) }),
);

const voices = new Map();
const voiceData = (voicePath) => {
  let data = voices.get(voicePath);
  if (!data) {
    const bytes = fs.readFileSync(voicePath);
    data = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    voices.set(voicePath, data);
  }
  return data;
};

const handle = async (request) => {
  if (request.op === "phonemize") {
    return { phonemes: await phonemize(request.text, request.language) };
  }
  const ids = request.ids;
  // Kokoro voices hold one 256-value style vector per phoneme count.
  const offset = 256 * Math.min(Math.max(ids.length - 2, 0), 509);
  const result = await (await session).run({
    input_ids: new ort.Tensor("int64", BigInt64Array.from(ids, BigInt), [1, ids.length]),
    style: new ort.Tensor("float32", voiceData(request.voicePath).slice(offset, offset + 256), [1, 256]),
    speed: new ort.Tensor("float32", new Float32Array([1]), [1]),
  });
  const audio = result.waveform.data;
  return { audio: Buffer.from(audio.buffer, audio.byteOffset, audio.byteLength).toString("base64") };
};

let queue = Promise.resolve();
readline
  .createInterface({ input: process.stdin })
  .on("line", (line) => {
    const request = JSON.parse(line);
    queue = queue
      .then(() => handle(request))
      .then(
        (result) => send({ id: request.id, ...result }),
        (error) => send({ id: request.id, error: describe(error) }),
      );
  })
  .on("close", () => queue.finally(() => process.exit(0)));
`;
