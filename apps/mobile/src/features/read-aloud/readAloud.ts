import { parseScopedThreadKey, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { ReadAloudController } from "@t3tools/client-runtime/read-aloud-controller";
import { environmentSpeechGenerator } from "@t3tools/client-runtime/read-aloud-speech";
import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { AtomRegistry } from "effect/reactivity";
import { createAudioPlayer } from "expo-audio";
import { Directory, File, Paths } from "expo-file-system";
import { Platform } from "react-native";

import { connectionAtomRuntime } from "../../connection/runtime";
import {
  acquireAudioSession,
  activateAudioSession,
  disposeAudioPlayer,
  isAudioSessionOwner,
  releaseAudioSession,
} from "../../lib/audioSession";
import { uuidv4 } from "../../lib/uuid";
import { appAtomRegistry } from "../../state/atom-registry";
import { environmentThreadShells } from "../../state/threads";
import { keepReadAloudInBackground } from "./backgroundPlayback";
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
  current.active ??= activateAudioSession(current.token, {
    background: Platform.OS === "android",
  });
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
    const audio = createExpoPlaybackAudio(
      () => {
        const player = createAudioPlayer(file.uri, { updateInterval: 250 });
        return {
          play: () => player.play(),
          seekTo: (seconds) => player.seekTo(seconds),
          setPlaybackRate: (rate) => player.setPlaybackRate(rate),
          addListener: (event, listener) => player.addListener(event, listener),
          release: () => disposeAudioPlayer(player),
        };
      },
      chunk.duration,
      claimAudioSession,
    );
    return {
      audio,
      dispose: () => {
        audio.release();
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

if (Platform.OS === "android") {
  keepReadAloudInBackground(readAloud, {
    claim: claimAudioSession,
    createAnchor: (state) => {
      const file = new File(cacheDirectory(), "silence.wav");
      if (!file.exists) {
        file.create();
        file.writeSync(silentWav());
      }
      const player = createAudioPlayer(file.uri, { updateInterval: 1000 });
      player.loop = true;
      const source = readAloudSourceThread(state.messageKey);
      const title = source
        ? appAtomRegistry.get(environmentThreadShells.threadShellAtom(source))?.title?.trim()
        : undefined;
      player.setActiveForLockScreen(
        true,
        { title: title || "Read aloud", artist: "T3 Code" },
        // A live stream has no seek bar, which would only show the anchor's silent loop.
        { isLiveStream: true },
      );
      return {
        play: () => player.play(),
        pause: () => player.pause(),
        addListener: (event, listener) => player.addListener(event, listener),
        release: () => disposeAudioPlayer(player),
      };
    },
  });
}

/** One second of 8 kHz, 16-bit mono silence. */
function silentWav(): Uint8Array {
  const samples = 8000;
  const bytes = new Uint8Array(44 + samples * 2);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) bytes[offset + i] = text.charCodeAt(i);
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + samples * 2, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 8000, true);
  view.setUint32(28, 16000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, samples * 2, true);
  return bytes;
}

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
