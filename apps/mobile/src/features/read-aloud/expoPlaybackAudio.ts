import type {
  PlaybackAudio,
  PlaybackAudioEvent,
} from "@t3tools/client-runtime/read-aloud-controller";
import type { AudioStatus } from "expo-audio";

export interface ExpoPlayer {
  play(): void;
  pause(): void;
  seekTo(seconds: number): Promise<void>;
  setPlaybackRate(rate: number): void;
  addListener(
    event: "playbackStatusUpdate",
    listener: (status: ExpoPlayerStatus) => void,
  ): { remove(): void };
}

export type ExpoPlayerStatus = Pick<
  AudioStatus,
  "currentTime" | "playing" | "didJustFinish" | "isBuffering" | "isLoaded" | "error"
>;

// Status updates near the end can report a stopped clock just before `didJustFinish`.
const END_TOLERANCE_SECONDS = 0.25;

/**
 * Presents an Expo audio player as the media element the read-aloud controller drives.
 * `duration` comes from the chunk's sample count, so it is known before the player loads.
 * `beforePlay` claims the audio session and rejects when playback isn't allowed right now.
 */
export function createExpoPlaybackAudio(
  player: ExpoPlayer,
  duration: number,
  beforePlay: () => Promise<void>,
): PlaybackAudio & { readonly detach: () => void } {
  const listeners = new Map<PlaybackAudioEvent, Set<() => void>>();
  const emit = (type: PlaybackAudioEvent) => {
    for (const listener of listeners.get(type) ?? []) listener();
  };
  let time = 0;
  let rate = 1;
  let paused = true;
  let ended = false;
  // Expo reports a stopped clock while it prepares and seeks; only a stop after it ran is a pause.
  let running = false;
  let attempt = 0;

  const markPaused = () => {
    if (paused) return;
    paused = true;
    running = false;
    emit("pause");
  };

  const subscription = player.addListener("playbackStatusUpdate", (status) => {
    if (status.error) {
      markPaused();
      emit("error");
      return;
    }
    if (status.didJustFinish) {
      time = duration;
      ended = true;
      markPaused();
      emit("ended");
      return;
    }
    if (paused) return;
    if (Number.isFinite(status.currentTime)) time = Math.min(duration, status.currentTime);
    if (status.playing) {
      running = true;
      emit("timeupdate");
    } else if (
      running &&
      status.isLoaded &&
      !status.isBuffering &&
      time < duration - END_TOLERANCE_SECONDS
    ) {
      // The system paused it, for example on losing audio focus.
      markPaused();
    }
  });

  return {
    get currentTime() {
      return time;
    },
    set currentTime(value: number) {
      time = Math.max(0, Math.min(duration, value));
      if (time < duration) ended = false;
      running = false;
      void player.seekTo(time).catch(() => {});
    },
    get playbackRate() {
      return rate;
    },
    set playbackRate(value: number) {
      rate = value;
      player.setPlaybackRate(value);
    },
    get paused() {
      return paused;
    },
    get ended() {
      return ended;
    },
    async play() {
      const current = ++attempt;
      paused = false;
      ended = false;
      try {
        await beforePlay();
      } catch (error) {
        if (current === attempt) paused = true;
        throw error;
      }
      // Paused or restarted while the session was being claimed.
      if (current !== attempt || paused) return;
      player.play();
      emit("playing");
    },
    pause() {
      attempt++;
      player.pause();
      markPaused();
    },
    addEventListener(type, listener) {
      let set = listeners.get(type);
      if (!set) listeners.set(type, (set = new Set()));
      set.add(listener);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
    detach: () => subscription.remove(),
  };
}
