import { parseScopedThreadKey, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { ReadAloudController } from "@t3tools/client-runtime/read-aloud-controller";
import { environmentSpeechGenerator } from "@t3tools/client-runtime/read-aloud-speech";
import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { AtomRegistry } from "effect/reactivity";
import { createAudioPlayer } from "expo-audio";
import { Directory, File, Paths } from "expo-file-system";

import { connectionAtomRuntime } from "../../connection/runtime";
import {
  acquireAudioSession,
  activateAudioSession,
  disposeAudioPlayer,
  isAudioSessionOwner,
  pauseAudioPlayer,
  releaseAudioSession,
} from "../../lib/audioSession";
import { uuidv4 } from "../../lib/uuid";
import { appAtomRegistry } from "../../state/atom-registry";
import { createExpoPlaybackAudio } from "./expoPlaybackAudio";

type AudioSession = ReturnType<typeof acquireAudioSession>;

let session: { readonly token: AudioSession; active: Promise<boolean> | null } | null = null;

function notAllowed(message: string) {
  return Object.assign(new Error(message), { name: "NotAllowedError" });
}

/** Claims the shared audio session once per listen, so moving between chunks adds no delay. */
async function claimAudioSession(): Promise<void> {
  if (!session || !isAudioSessionOwner(session.token)) {
    const token = acquireAudioSession("playback", () => {
      // Recording or other playback took over.
      if (session?.token === token) session = null;
      readAloud.pause();
    });
    if (!isAudioSessionOwner(token)) throw notAllowed("Finish recording before reading aloud.");
    session = { token, active: null };
  }
  const current = session;
  current.active ??= activateAudioSession(current.token);
  if (!(await current.active)) {
    if (session === current) session = null;
    throw notAllowed("Couldn't start audio playback.");
  }
}

function releaseSession() {
  if (!session) return;
  const { token } = session;
  session = null;
  void releaseAudioSession(token).catch(() => {});
}

let cache: Directory | null = null;

function cacheDirectory(): Directory {
  if (!cache) {
    cache = new Directory(Paths.cache, "read-aloud");
    // Chunks are deleted as playback ends; this clears any a killed app left behind.
    if (cache.exists) cache.delete();
    cache.create({ intermediates: true, idempotent: true });
  }
  return cache;
}

export const readAloud = new ReadAloudController({
  generate: environmentSpeechGenerator(async (effect, signal) => {
    const context = await Effect.runPromise(
      AtomRegistry.getResult(appAtomRegistry, connectionAtomRuntime, { suspendOnWaiting: true }),
    );
    return Effect.runPromiseExitWith(context)(effect, { signal });
  }),
  createPlayback: (chunk) => {
    const file = new File(cacheDirectory(), `${uuidv4()}.wav`);
    file.create();
    file.writeSync(chunk.audio);
    const player = createAudioPlayer(file.uri, { updateInterval: 250 });
    const audio = createExpoPlaybackAudio(
      {
        play: () => player.play(),
        pause: () => pauseAudioPlayer(player),
        seekTo: (seconds) => player.seekTo(seconds),
        setPlaybackRate: (rate) => player.setPlaybackRate(rate),
        addListener: (event, listener) => player.addListener(event, listener),
      },
      chunk.duration,
      claimAudioSession,
    );
    return {
      audio,
      dispose: () => {
        audio.detach();
        disposeAudioPlayer(player);
        try {
          file.delete();
        } catch {}
      },
    };
  },
});

// The session is held while the user is listening, including between chunks.
readAloud.subscribe(() => {
  const status = readAloud.getSnapshot()?.status;
  if (status !== "playing" && status !== "buffering" && status !== "preparing") releaseSession();
});

export function readAloudMessageKey(
  environmentId: EnvironmentId,
  threadId: ThreadId,
  messageId: string,
): string {
  return `${scopedThreadKey({ environmentId, threadId })}\0${messageId}`;
}

export function readAloudSourceThread(messageKey: string): ScopedThreadRef | null {
  const separator = messageKey.indexOf("\0");
  return separator === -1 ? null : parseScopedThreadKey(messageKey.slice(0, separator));
}
