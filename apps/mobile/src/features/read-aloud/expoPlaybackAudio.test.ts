import { describe, expect, it } from "vite-plus/test";

import {
  createExpoPlaybackAudio,
  type ExpoPlayer,
  type ExpoPlayerStatus,
} from "./expoPlaybackAudio";

function setup(beforePlay: () => Promise<void> = async () => {}) {
  let report!: (status: ExpoPlayerStatus) => void;
  const calls: string[] = [];
  const openPlayer = (): ExpoPlayer => {
    calls.push("open");
    return {
      play: () => calls.push("play"),
      seekTo: async (seconds) => {
        calls.push(`seek ${seconds}`);
      },
      setPlaybackRate: (rate) => calls.push(`rate ${rate}`),
      addListener: (_event, listener) => {
        report = listener;
        return { remove: () => calls.push("removed") };
      },
      release: () => calls.push("release"),
    };
  };
  const audio = createExpoPlaybackAudio(openPlayer, 10, beforePlay);
  const events: string[] = [];
  for (const type of ["playing", "pause", "timeupdate", "ended", "error"] as const) {
    audio.addEventListener(type, () => events.push(type));
  }
  const status = (patch: Partial<ExpoPlayerStatus>) =>
    report({
      currentTime: 0,
      playing: false,
      didJustFinish: false,
      isBuffering: false,
      isLoaded: true,
      error: null,
      ...patch,
    });
  return { audio, calls, events, status };
}

describe("createExpoPlaybackAudio", () => {
  it("plays, reports progress, then pauses and ends like a media element", async () => {
    const { audio, calls, events, status } = setup();
    await audio.play();
    expect(calls).toEqual(["open", "play"]);
    expect(audio.paused).toBe(false);
    status({ currentTime: 4, playing: true });
    expect(audio.currentTime).toBe(4);

    status({ currentTime: 10, didJustFinish: true });
    expect(audio).toMatchObject({ paused: true, ended: true, currentTime: 10 });
    expect(events).toEqual(["playing", "timeupdate", "pause", "ended"]);
    expect(calls).toEqual(["open", "play", "removed", "release"]);
  });

  it("holds a native player only while playing, so long responses don't run out of them", async () => {
    const { audio, calls, status } = setup();
    audio.currentTime = 2;
    audio.playbackRate = 1.25;
    expect(calls).toEqual([]);
    await audio.play();
    status({ currentTime: 4, playing: true });
    audio.pause();
    expect(calls).toEqual(["open", "rate 1.25", "seek 2", "play", "removed", "release"]);

    calls.length = 0;
    await audio.play();
    audio.release();
    expect(calls).toEqual(["open", "rate 1.25", "seek 4", "play", "removed", "release"]);
  });

  it("ignores a stopped clock while starting or seeking, but reports a system pause", async () => {
    const { audio, events, status } = setup();
    await audio.play();
    status({ currentTime: 0, playing: false });
    expect(audio.paused).toBe(false);

    status({ currentTime: 3, playing: true });
    audio.currentTime = 6;
    status({ currentTime: 6, playing: false });
    expect(audio.paused).toBe(false);

    status({ currentTime: 6.5, playing: true });
    status({ currentTime: 6.5, playing: false, isBuffering: true });
    expect(audio.paused).toBe(false);
    status({ currentTime: 6.5, playing: false });
    expect(audio.paused).toBe(true);
    expect(events.at(-1)).toBe("pause");
  });

  it("does not start when paused while the audio session is being claimed", async () => {
    let claim!: () => void;
    const { audio, calls } = setup(() => new Promise((resolve) => (claim = resolve)));
    const playing = audio.play();
    audio.pause();
    claim();
    await playing;
    expect(calls).toEqual([]);
    expect(audio.paused).toBe(true);
  });

  it("stays paused when the audio session refuses playback", async () => {
    const refused = Object.assign(new Error("Recording"), { name: "NotAllowedError" });
    const { audio, calls } = setup(async () => {
      throw refused;
    });
    await expect(audio.play()).rejects.toBe(refused);
    expect(audio.paused).toBe(true);
    expect(calls).toEqual([]);
  });

  it("seeks within the chunk, clears ended, and applies speed", async () => {
    const { audio, calls, status } = setup();
    await audio.play();
    status({ currentTime: 10, didJustFinish: true });
    audio.currentTime = 30;
    expect(audio).toMatchObject({ currentTime: 10, ended: true });
    audio.currentTime = 0;
    audio.playbackRate = 1.5;
    expect(audio).toMatchObject({ currentTime: 0, ended: false, playbackRate: 1.5 });
    expect(calls).toEqual(["open", "play", "removed", "release"]);
    await audio.play();
    audio.currentTime = 3;
    expect(calls.slice(4)).toEqual(["open", "rate 1.5", "play", "seek 3"]);
  });

  it("reports a player error", async () => {
    const { audio, events, status } = setup();
    await audio.play();
    status({ error: "decoder failed" });
    expect(events).toEqual(["playing", "pause", "error"]);
  });
});
