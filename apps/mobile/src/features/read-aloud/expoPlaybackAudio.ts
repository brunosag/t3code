import type {
  PlaybackAudio,
  PlaybackAudioEvent,
} from "@t3tools/client-runtime/read-aloud-controller";
import type { AudioStatus } from "expo-audio";

export interface ExpoPlayer {
  play(): void;
  seekTo(seconds: number): Promise<void>;
  setPlaybackRate(rate: number): void;
  addListener(
    event: "playbackStatusUpdate",
    listener: (status: ExpoPlayerStatus) => void,
  ): { remove(): void };
  release(): void;
}

export type ExpoPlayerStatus = Pick<
  AudioStatus,
  "currentTime" | "playing" | "didJustFinish" | "isBuffering" | "isLoaded" | "error"
>;

// Status updates near the end can report a stopped clock just before `didJustFinish`.
const END_TOLERANCE_SECONDS = 0.25;

/**
 * Presents a chunk as the media element the read-aloud controller drives; `duration` comes from
 * its sample count and `beforePlay` claims the audio session. Each loaded player holds one of
 * Android's limited audio tracks, so one is open only while its chunk plays.
 */
export function createExpoPlaybackAudio(
  openPlayer: () => ExpoPlayer,
  duration: number,
  beforePlay: () => Promise<void>,
): PlaybackAudio & { readonly release: () => void } {
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
  let native: { readonly player: ExpoPlayer; readonly subscription: { remove(): void } } | null =
    null;

  const close = () => {
    if (!native) return;
    native.subscription.remove();
    native.player.release();
    native = null;
  };

  const markPaused = () => {
    close();
    if (paused) return;
    paused = true;
    running = false;
    emit("pause");
  };

  const onStatus = (status: ExpoPlayerStatus) => {
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
  };

  const open = () => {
    if (native) return native.player;
    const player = openPlayer();
    native = { player, subscription: player.addListener("playbackStatusUpdate", onStatus) };
    running = false;
    if (rate !== 1) player.setPlaybackRate(rate);
    if (time > 0) void player.seekTo(time).catch(() => {});
    return player;
  };

  return {
    get currentTime() {
      return time;
    },
    set currentTime(value: number) {
      time = Math.max(0, Math.min(duration, value));
      if (time < duration) ended = false;
      running = false;
      if (native) void native.player.seekTo(time).catch(() => {});
    },
    get playbackRate() {
      return rate;
    },
    set playbackRate(value: number) {
      rate = value;
      native?.player.setPlaybackRate(value);
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
      open().play();
      emit("playing");
    },
    pause() {
      attempt++;
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
    release: close,
  };
}
