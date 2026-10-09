import { ReadAloudController, type ReadAloudBackend } from "./readAloudController";
import type { SpeechWorkerResponse } from "./readAloud.worker";

const generate: ReadAloudBackend["generate"] = (request, signal, onProgress) =>
  new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Stopped", "AbortError"));
      return;
    }
    const worker = new Worker(new URL("./readAloud.worker.ts", import.meta.url), {
      type: "module",
    });
    const cleanup = () => {
      signal.removeEventListener("abort", abort);
      // Releases inference memory as well as cancelling any in-flight model download.
      worker.terminate();
    };
    const abort = () => {
      cleanup();
      reject(new DOMException("Stopped", "AbortError"));
    };
    signal.addEventListener("abort", abort, { once: true });
    worker.addEventListener("message", (event: MessageEvent<SpeechWorkerResponse>) => {
      const message = event.data;
      switch (message.type) {
        case "progress":
          onProgress(message.progress);
          break;
        case "complete":
          cleanup();
          resolve(message.blob);
          break;
        case "error":
          cleanup();
          reject(new Error(message.error));
          break;
      }
    });
    worker.addEventListener("error", () => {
      cleanup();
      reject(
        new Error("Unable to load the local speech engine. Check your connection and try again."),
      );
    });
    worker.postMessage(request, {});
  });

export const readAloud = new ReadAloudController({
  generate,
  createPlayback: (blob) => {
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    return {
      audio,
      dispose: () => {
        audio.removeAttribute("src");
        audio.load();
        URL.revokeObjectURL(url);
      },
    };
  },
});

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => readAloud.stop());
}
if (import.meta.hot) import.meta.hot.dispose(() => readAloud.stop());
