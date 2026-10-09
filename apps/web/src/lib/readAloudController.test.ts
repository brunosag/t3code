import { describe, expect, it } from "vite-plus/test";

import { ReadAloudController, type ReadAloudBackend } from "./readAloudController";

class TestAudio extends EventTarget {
  currentTime = 0;
  duration = 60;
  playbackRate = 1;
  paused = true;
  ended = false;

  async play() {
    this.paused = false;
    this.ended = false;
    this.dispatchEvent(new Event("playing"));
  }

  pause() {
    this.paused = true;
    this.dispatchEvent(new Event("pause"));
  }
}

function setup(generate: ReadAloudBackend["generate"] = async () => new Blob()) {
  const audio = new TestAudio();
  let disposed = 0;
  const player = new ReadAloudController({
    generate,
    createPlayback: () => ({
      audio,
      dispose: () => {
        disposed += 1;
      },
    }),
  });
  return { audio, player, disposed: () => disposed };
}

describe("ReadAloudController", () => {
  it("plays, pauses, and resumes the same response", async () => {
    const { player, audio } = setup();
    await player.start("response-1", "Hello.");
    expect(player.getSnapshot("response-1")?.status).toBe("playing");
    expect(audio.paused).toBe(false);

    audio.currentTime = 12;
    player.pause();
    expect(player.getSnapshot("response-1")).toMatchObject({ status: "paused", position: 12 });

    await player.resume();
    expect(player.getSnapshot("response-1")).toMatchObject({ status: "playing", position: 12 });
  });

  it("shows media progress and seeks in seconds without resynthesizing", async () => {
    let generated = 0;
    const { player, audio } = setup(async () => {
      generated += 1;
      return new Blob();
    });
    await player.start("response", "Hello.");
    audio.currentTime = 15;
    audio.dispatchEvent(new Event("timeupdate"));
    expect(player.getSnapshot("response")).toMatchObject({ position: 15, duration: 60 });
    player.seek(40);
    expect(audio.currentTime).toBe(40);
    player.seek(90);
    expect(audio.currentTime).toBe(60);
    player.seek(-10);
    expect(audio.currentTime).toBe(0);
    player.seek(Number.NaN);
    expect(audio.currentTime).toBe(0);
    player.pause();
    player.seek(25);
    expect(player.getSnapshot("response")).toMatchObject({ position: 25, status: "paused" });
    expect(generated).toBe(1);
  });

  it("adjusts playback speed immediately and retains it for the next response", async () => {
    const { player, audio } = setup();
    await player.start("first", "First.");
    player.setSpeed(1.5);
    expect(audio.playbackRate).toBe(1.5);
    player.setSpeed(9);
    player.setSpeed(Number.NaN);
    expect(audio.playbackRate).toBe(1.5);
    player.stop();
    await player.start("second", "Second.");
    expect(player.getSnapshot("second")?.speed).toBe(1.5);
    expect(audio.playbackRate).toBe(1.5);
  });

  it("stops audio and releases its resources", async () => {
    const { player, audio, disposed } = setup();
    await player.start("response", "Hello.");
    player.stop();
    expect(audio.paused).toBe(true);
    expect(disposed()).toBe(1);
    expect(player.getSnapshot("response")).toBeNull();
    audio.dispatchEvent(new Event("timeupdate"));
    expect(player.getSnapshot("response")).toBeNull();
  });

  it("discards a generation result arriving after Stop", async () => {
    let finish!: (blob: Blob) => void;
    let signal: AbortSignal | undefined;
    const { player, audio } = setup((_text, nextSignal, progress) => {
      signal = nextSignal;
      progress({ label: "Generating speech…", percent: 50 });
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    const pending = player.start("response", "Hello.");
    expect(player.getSnapshot("response")).toMatchObject({
      status: "preparing",
      progress: { percent: 50 },
    });
    player.stop();
    expect(signal?.aborted).toBe(true);
    finish(new Blob());
    await pending;
    expect(player.getSnapshot("response")).toBeNull();
    expect(audio.paused).toBe(true);
  });

  it("keeps newer playback when an older generation finishes late", async () => {
    let finishFirst!: (blob: Blob) => void;
    let reportFirst!: Parameters<ReadAloudBackend["generate"]>[2];
    const { player, disposed } = setup((text, _signal, progress) => {
      if (text === "First.") {
        reportFirst = progress;
        return new Promise((resolve) => {
          finishFirst = resolve;
        });
      }
      return Promise.resolve(new Blob());
    });
    const pending = player.start("first", "First.");
    await player.start("second", "Second.");
    const secondSnapshot = player.getSnapshot("second");
    reportFirst({ label: "Stale progress", percent: 99 });
    finishFirst(new Blob());
    await pending;
    expect(player.getSnapshot("first")).toBeNull();
    expect(player.getSnapshot("second")).toBe(secondSnapshot);
    expect(secondSnapshot?.status).toBe("playing");
    expect(disposed()).toBe(0);
  });

  it("replaces active audio without overlapping responses", async () => {
    const { player, audio, disposed } = setup();
    await player.start("first", "First.");
    const second = player.start("second", "Second.");
    expect(audio.paused).toBe(true);
    expect(disposed()).toBe(1);
    await second;
    player.stopMessage("first");
    expect(player.getSnapshot("second")?.status).toBe("playing");
    player.stopMessage("second");
    expect(player.getSnapshot("second")).toBeNull();
  });

  it("can replay after reaching the end", async () => {
    const { player, audio } = setup();
    await player.start("response", "Hello.");
    audio.currentTime = 60;
    audio.ended = true;
    audio.paused = true;
    audio.dispatchEvent(new Event("ended"));
    expect(player.getSnapshot("response")?.status).toBe("ended");
    await player.resume();
    expect(audio.currentTime).toBe(0);
    expect(player.getSnapshot("response")?.status).toBe("playing");
  });

  it("reports generation failure and lets the response retry", async () => {
    let failed = false;
    const { player } = setup(async () => {
      if (!failed) {
        failed = true;
        throw new Error("Model download failed.");
      }
      return new Blob();
    });
    await player.start("response", "Hello.");
    expect(player.getSnapshot("response")).toMatchObject({
      status: "error",
      error: "Model download failed.",
    });
    await player.start("response", "Hello.");
    expect(player.getSnapshot("response")?.status).toBe("playing");
  });

  it("keeps prepared audio when autoplay is blocked, then plays on another gesture", async () => {
    const { player, audio, disposed } = setup();
    const play = audio.play.bind(audio);
    audio.play = async () => {
      throw new DOMException("Gesture required", "NotAllowedError");
    };
    await player.start("response", "Hello.");
    expect(player.getSnapshot("response")).toMatchObject({
      status: "paused",
      error: "Speech is ready. Press Play to listen.",
    });
    expect(disposed()).toBe(0);
    audio.play = play;
    await player.resume();
    expect(player.getSnapshot("response")).toMatchObject({ status: "playing", error: null });
  });
});
