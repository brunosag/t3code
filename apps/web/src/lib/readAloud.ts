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

export const READ_ALOUD_SEEK_SECONDS = 10;

// Each sentence plays in its own audio element, so without these the browser's media keys and
// system controls act on one sentence's element and get out of step with the player.
function syncMediaSession(session: MediaSession) {
  const handlers: Partial<Record<MediaSessionAction, MediaSessionActionHandler>> = {
    play: () => void readAloud.resume(),
    pause: () => readAloud.pause(),
    stop: () => readAloud.stop(),
    seekbackward: (details) => readAloud.seekBy(-(details.seekOffset ?? READ_ALOUD_SEEK_SECONDS)),
    seekforward: (details) => readAloud.seekBy(details.seekOffset ?? READ_ALOUD_SEEK_SECONDS),
    // Keyboards carry track keys rather than seek keys.
    previoustrack: () => readAloud.seekBy(-READ_ALOUD_SEEK_SECONDS),
    nexttrack: () => readAloud.seekBy(READ_ALOUD_SEEK_SECONDS),
    seekto: (details) => {
      if (details.seekTime !== undefined) readAloud.seek(details.seekTime);
    },
  };
  const setHandlers = (enabled: boolean) => {
    for (const [action, handler] of Object.entries(handlers)) {
      try {
        session.setActionHandler(action as MediaSessionAction, enabled ? handler : null);
      } catch {
        // Browsers throw for actions they don't support.
      }
    }
  };
  setHandlers(true);
  const unsubscribe = readAloud.subscribe(() => {
    const state = readAloud.getSnapshot();
    const playing = state?.status === "playing" || state?.status === "buffering";
    session.playbackState = !state ? "none" : playing ? "playing" : "paused";
    if (!state || state.duration <= 0) return;
    try {
      session.setPositionState({
        duration: state.duration,
        position: Math.min(state.position, state.duration),
        playbackRate: state.speed,
      });
    } catch {
      // Unsupported, or a transient state the browser rejects.
    }
  });
  return () => {
    unsubscribe();
    setHandlers(false);
  };
}

const stopMediaSession =
  typeof navigator !== "undefined" && "mediaSession" in navigator
    ? syncMediaSession(navigator.mediaSession)
    : undefined;

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => readAloud.stop());
}
if (import.meta.hot)
  import.meta.hot.dispose(() => {
    stopMediaSession?.();
    readAloud.stop();
  });
