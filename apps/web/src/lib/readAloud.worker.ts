import { env, KokoroTTS, TextSplitterStream } from "kokoro-js";
import { env as transformersEnv, RawAudio } from "@huggingface/transformers";
import wasmUrl from "@read-aloud-runtime/ort-wasm-simd-threaded.jsep.wasm?url";
import mjsUrl from "@read-aloud-runtime/ort-wasm-simd-threaded.jsep.mjs?url";
import type { SpeechGenerationProgress, SpeechRequest } from "./readAloudController";

export type SpeechWorkerResponse =
  | { readonly type: "progress"; readonly progress: SpeechGenerationProgress }
  | { readonly type: "complete"; readonly blob: Blob }
  | { readonly type: "error"; readonly error: string };

function send(message: SpeechWorkerResponse): void {
  self.postMessage(message, {});
}

// Single-threaded WASM also works on remote origins without cross-origin isolation.
transformersEnv.allowLocalModels = false;
if (transformersEnv.backends.onnx.wasm) transformersEnv.backends.onnx.wasm.numThreads = 1;
env.wasmPaths = {
  wasm: new URL(wasmUrl, self.location.href).href,
  mjs: new URL(mjsUrl, self.location.href).href,
};

self.addEventListener("message", async (event: MessageEvent<SpeechRequest>) => {
  const { text, voice } = event.data;
  try {
    const tts = await KokoroTTS.from_pretrained("onnx-community/Kokoro-82M-v1.0-ONNX", {
      dtype: "q8",
      device: "wasm",
      progress_callback: (progress) => {
        if (progress.status === "progress") {
          send({
            type: "progress",
            progress: {
              label: "Downloading local voice…",
              percent: Math.round(progress.progress),
            },
          });
        }
      },
    });
    // Keep generation increments short; token length is checked after numeric expansion below.
    const chunks: string[] = [];
    for (const sentence of text.split(/(?<=[.!?])\s+|\n+/)) {
      let remaining = sentence.trim();
      while (remaining.length > 180) {
        const space = remaining.lastIndexOf(" ", 180);
        const end = space > 0 ? space : 180;
        chunks.push(remaining.slice(0, end));
        remaining = remaining.slice(end).trim();
      }
      if (remaining) chunks.push(remaining);
    }
    const samples: Float32Array[] = [];
    let sampleCount = 0;
    for (const [index, chunk] of chunks.entries()) {
      send({
        type: "progress",
        progress: {
          label: `Generating speech (${index + 1} of ${chunks.length})…`,
          percent: Math.round((index / chunks.length) * 100),
        },
      });
      const sentences = new TextSplitterStream();
      sentences.push(chunk);
      sentences.close();
      for await (const result of tts.stream(sentences, { voice })) {
        const append = (audio: Float32Array) => {
          samples.push(audio);
          sampleCount += audio.length;
        };
        const tokens = tts.tokenizer(result.phonemes, { truncation: false }).input_ids;
        if (tokens.dims.at(-1)! <= 510) {
          append(result.audio.audio);
          continue;
        }
        // Kokoro's stream exposes normalized phonemes even when its audio was truncated.
        // Resynthesize bounded phoneme segments instead of keeping that incomplete audio.
        async function appendPhonemes(phonemes: string): Promise<void> {
          const inputIds = tts.tokenizer(phonemes, { truncation: false }).input_ids;
          if (inputIds.dims.at(-1)! <= 510) {
            append((await tts.generate_from_ids(inputIds, { voice })).audio);
            return;
          }
          const middle = Math.floor(phonemes.length / 2);
          const space = phonemes.lastIndexOf(" ", middle);
          const split = space > 0 ? space : middle;
          await appendPhonemes(phonemes.slice(0, split));
          await appendPhonemes(phonemes.slice(split).trimStart());
        }
        await appendPhonemes(result.phonemes);
      }
    }
    const combined = new Float32Array(sampleCount);
    let offset = 0;
    for (const sample of samples) {
      combined.set(sample, offset);
      offset += sample.length;
    }
    send({ type: "complete", blob: new RawAudio(combined, 24_000).toBlob() });
  } catch (error) {
    console.error("Local speech generation failed", error);
    send({
      type: "error",
      error: "Unable to prepare local speech. Check your connection and try again.",
    });
  }
});
