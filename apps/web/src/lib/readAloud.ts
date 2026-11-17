import { ReadAloudController } from "@t3tools/client-runtime/read-aloud-controller";
import { environmentSpeechGenerator } from "@t3tools/client-runtime/read-aloud-speech";
import * as Effect from "effect/Effect";
import { AtomRegistry } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";

export const readAloud = new ReadAloudController({
  generate: environmentSpeechGenerator(async (effect, signal) => {
    const context = await Effect.runPromise(
      AtomRegistry.getResult(appAtomRegistry, connectionAtomRuntime, { suspendOnWaiting: true }),
    );
    return Effect.runPromiseExitWith(context)(effect, { signal });
  }),
  createPlayback: (chunk) => {
    const url = URL.createObjectURL(new Blob([chunk.audio.slice()], { type: "audio/wav" }));
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
