import { describe, expect, it } from "vite-plus/test";

import { EnvironmentId } from "@t3tools/contracts";

import { ReadAloudController, type ReadAloudBackend } from "./readAloudController";

const environmentId = EnvironmentId.make("environment");

class TestAudio extends EventTarget {
  private time = 0;
  playbackRate = 1;
  paused = true;
  ended = false;

  constructor(readonly duration: number) {
    super();
  }

  get currentTime() {
    return this.time;
  }

  // Like a media element, moving away from the end clears `ended`.
  set currentTime(value: number) {
    this.time = value;
    if (value < this.duration) this.ended = false;
  }

  async play() {
    this.paused = false;
    this.ended = false;
    this.dispatchEvent(new Event("playing"));
  }

  pause() {
    this.paused = true;
    this.dispatchEvent(new Event("pause"));
  }

  /** Mirrors a media element reaching its end: it pauses, then reports ended. */
  finish() {
    this.currentTime = this.duration;
    this.ended = true;
    this.paused = true;
    this.dispatchEvent(new Event("pause"));
    this.dispatchEvent(new Event("ended"));
  }
}

const oneChunk: ReadAloudBackend["generate"] = async (_request, _signal, _progress, onChunk) => {
  onChunk({ blob: new Blob(), duration: 60 });
};

function setup(generate: ReadAloudBackend["generate"] = oneChunk) {
  const audios: TestAudio[] = [];
  const durations = new Map<Blob, number>();
  let disposed = 0;
  const player = new ReadAloudController({
    generate: (request, signal, onProgress, onChunk) =>
      generate(request, signal, onProgress, (chunk) => {
        durations.set(chunk.blob, chunk.duration);
        onChunk(chunk);
      }),
    createPlayback: (blob) => {
      const audio = new TestAudio(durations.get(blob) ?? 0);
      audios.push(audio);
      return {
        audio,
        dispose: () => {
          disposed += 1;
        },
      };
    },
  });
  return { audios, player, disposed: () => disposed };
}

/** A generation whose chunks and completion the test releases one at a time. */
function streamed() {
  let emit!: (duration: number) => void;
  let finish!: () => void;
  let fail!: (error: Error) => void;
  const generate: ReadAloudBackend["generate"] = (_request, _signal, _progress, onChunk) => {
    emit = (duration) => onChunk({ blob: new Blob(), duration });
    return new Promise((resolve, reject) => {
      finish = resolve;
      fail = reject;
    });
  };
  return {
    generate,
    emit: (duration: number) => emit(duration),
    finish: () => finish(),
    fail: (error: Error) => fail(error),
  };
}

describe("ReadAloudController", () => {
  it("plays, pauses, and resumes the same response", async () => {
    const { player, audios } = setup();
    await player.start("response-1", { environmentId, text: "Hello.", voice: "af_heart" });
    expect(player.getSnapshot("response-1")?.status).toBe("playing");
    expect(audios[0]!.paused).toBe(false);

    audios[0]!.currentTime = 12;
    player.pause();
    expect(player.getSnapshot("response-1")).toMatchObject({ status: "paused", position: 12 });

    await player.resume();
    expect(player.getSnapshot("response-1")).toMatchObject({ status: "playing", position: 12 });
  });

  it("starts playing the first chunk while later chunks are still generating", async () => {
    const generation = streamed();
    const { player, audios } = setup(generation.generate);
    const pending = player.start("response", {
      environmentId,
      text: "One. Two.",
      voice: "af_heart",
    });
    expect(player.getSnapshot("response")?.status).toBe("preparing");

    generation.emit(4);
    expect(audios[0]!.paused).toBe(false);
    expect(player.getSnapshot("response")).toMatchObject({ status: "playing", duration: 4 });
    expect(player.getSnapshot("response")?.progress).not.toBeNull();

    generation.emit(6);
    expect(audios[1]!.paused).toBe(true);
    expect(player.getSnapshot("response")?.duration).toBe(10);

    audios[0]!.finish();
    expect(audios[1]!.paused).toBe(false);
    audios[1]!.currentTime = 2;
    audios[1]!.dispatchEvent(new Event("timeupdate"));
    expect(player.getSnapshot("response")).toMatchObject({ status: "playing", position: 6 });

    generation.finish();
    await pending;
    expect(player.getSnapshot("response")?.progress).toBeNull();
    audios[1]!.finish();
    expect(player.getSnapshot("response")).toMatchObject({ status: "ended", position: 10 });
  });

  it("buffers when playback catches up with generation, then continues", async () => {
    const generation = streamed();
    const { player, audios } = setup(generation.generate);
    const pending = player.start("response", {
      environmentId,
      text: "One. Two.",
      voice: "af_heart",
    });
    generation.emit(4);
    audios[0]!.finish();
    expect(player.getSnapshot("response")?.status).toBe("buffering");

    generation.emit(6);
    expect(audios[1]!.paused).toBe(false);
    expect(player.getSnapshot("response")).toMatchObject({ status: "playing", position: 4 });

    generation.finish();
    await pending;
  });

  it("does not resume a paused response when the next chunk arrives", async () => {
    const generation = streamed();
    const { player, audios } = setup(generation.generate);
    const pending = player.start("response", {
      environmentId,
      text: "One. Two.",
      voice: "af_heart",
    });
    generation.emit(4);
    audios[0]!.finish();
    player.pause();
    expect(player.getSnapshot("response")?.status).toBe("paused");

    generation.emit(6);
    expect(audios[1]!.paused).toBe(true);
    await player.resume();
    expect(audios[1]!.paused).toBe(false);

    generation.finish();
    await pending;
  });

  it("shows media progress and seeks across chunks without resynthesizing", async () => {
    let generated = 0;
    const { player, audios } = setup(async (_request, _signal, _progress, onChunk) => {
      generated += 1;
      onChunk({ blob: new Blob(), duration: 30 });
      onChunk({ blob: new Blob(), duration: 30 });
    });
    await player.start("response", { environmentId, text: "Hello.", voice: "af_heart" });
    audios[0]!.currentTime = 15;
    audios[0]!.dispatchEvent(new Event("timeupdate"));
    expect(player.getSnapshot("response")).toMatchObject({ position: 15, duration: 60 });

    player.seek(40);
    expect(audios[0]!.paused).toBe(true);
    expect(audios[1]!.currentTime).toBe(10);
    expect(audios[1]!.paused).toBe(false);
    expect(player.getSnapshot("response")).toMatchObject({ position: 40, status: "playing" });
    player.seek(90);
    expect(audios[1]!.currentTime).toBe(30);
    player.seek(-10);
    expect(audios[0]!.currentTime).toBe(0);
    expect(audios[0]!.paused).toBe(false);
    player.seek(Number.NaN);
    expect(audios[0]!.currentTime).toBe(0);

    player.pause();
    player.seek(45);
    expect(audios[1]!.paused).toBe(true);
    expect(player.getSnapshot("response")).toMatchObject({ position: 45, status: "paused" });
    expect(generated).toBe(1);
  });

  it("adjusts playback speed immediately and retains it for the next response", async () => {
    const { player, audios } = setup();
    await player.start("first", { environmentId, text: "First.", voice: "af_heart" });
    player.setSpeed(1.5);
    expect(audios[0]!.playbackRate).toBe(1.5);
    player.setSpeed(9);
    player.setSpeed(Number.NaN);
    expect(audios[0]!.playbackRate).toBe(1.5);
    player.stop();
    await player.start("second", { environmentId, text: "Second.", voice: "af_heart" });
    expect(player.getSnapshot("second")?.speed).toBe(1.5);
    expect(audios[1]!.playbackRate).toBe(1.5);
  });

  it("stops audio and releases its resources", async () => {
    const { player, audios, disposed } = setup();
    await player.start("response", { environmentId, text: "Hello.", voice: "af_heart" });
    player.stop();
    expect(audios[0]!.paused).toBe(true);
    expect(disposed()).toBe(1);
    expect(player.getSnapshot("response")).toBeNull();
    audios[0]!.dispatchEvent(new Event("timeupdate"));
    expect(player.getSnapshot("response")).toBeNull();
  });

  it("stops generating and discards chunks arriving after Stop", async () => {
    let signal: AbortSignal | undefined;
    const generation = streamed();
    const { player, audios } = setup((request, nextSignal, progress, onChunk) => {
      signal = nextSignal;
      progress({ label: "Generating speech…", percent: 50 });
      return generation.generate(request, nextSignal, progress, onChunk);
    });
    const pending = player.start("response", { environmentId, text: "Hello.", voice: "af_heart" });
    expect(player.getSnapshot("response")).toMatchObject({
      status: "preparing",
      progress: { percent: 50 },
    });
    player.stop();
    expect(signal?.aborted).toBe(true);
    generation.emit(4);
    generation.finish();
    await pending;
    expect(player.getSnapshot("response")).toBeNull();
    expect(audios).toHaveLength(0);
  });

  it("keeps newer playback when an older generation finishes late", async () => {
    const first = streamed();
    let reportFirst!: Parameters<ReadAloudBackend["generate"]>[2];
    const { player, disposed } = setup((request, signal, progress, onChunk) => {
      if (request.text === "First.") {
        reportFirst = progress;
        return first.generate(request, signal, progress, onChunk);
      }
      return oneChunk(request, signal, progress, onChunk);
    });
    const pending = player.start("first", { environmentId, text: "First.", voice: "af_heart" });
    await player.start("second", { environmentId, text: "Second.", voice: "af_heart" });
    const secondSnapshot = player.getSnapshot("second");
    reportFirst({ label: "Stale progress", percent: 99 });
    first.emit(4);
    first.finish();
    await pending;
    expect(player.getSnapshot("first")).toBeNull();
    expect(player.getSnapshot("second")).toBe(secondSnapshot);
    expect(secondSnapshot?.status).toBe("playing");
    expect(disposed()).toBe(0);
  });

  it("replaces active audio without overlapping responses", async () => {
    const { player, audios, disposed } = setup();
    await player.start("first", { environmentId, text: "First.", voice: "af_heart" });
    const second = player.start("second", { environmentId, text: "Second.", voice: "af_heart" });
    expect(audios[0]!.paused).toBe(true);
    expect(disposed()).toBe(1);
    await second;
    player.stopMessage("first");
    expect(player.getSnapshot("second")?.status).toBe("playing");
    player.stopMessage("second");
    expect(player.getSnapshot("second")).toBeNull();
  });

  it("can replay after reaching the end", async () => {
    const { player, audios } = setup();
    await player.start("response", { environmentId, text: "Hello.", voice: "af_heart" });
    audios[0]!.finish();
    expect(player.getSnapshot("response")?.status).toBe("ended");
    player.seek(30);
    expect(player.getSnapshot("response")?.status).toBe("paused");
    audios[0]!.finish();
    await player.resume();
    expect(audios[0]!.currentTime).toBe(0);
    expect(player.getSnapshot("response")?.status).toBe("playing");
  });

  it("reports generation failure and lets the response retry", async () => {
    let failed = false;
    const { player } = setup(async (request, signal, progress, onChunk) => {
      if (!failed) {
        failed = true;
        throw new Error("Model download failed.");
      }
      return oneChunk(request, signal, progress, onChunk);
    });
    await player.start("response", { environmentId, text: "Hello.", voice: "af_heart" });
    expect(player.getSnapshot("response")).toMatchObject({
      status: "error",
      error: "Model download failed.",
    });
    await player.start("response", { environmentId, text: "Hello.", voice: "af_heart" });
    expect(player.getSnapshot("response")?.status).toBe("playing");
  });

  it("keeps already generated audio playable when generation fails midway", async () => {
    const generation = streamed();
    const { player, audios } = setup(generation.generate);
    const pending = player.start("response", {
      environmentId,
      text: "One. Two.",
      voice: "af_heart",
    });
    generation.emit(4);
    generation.fail(new Error("Unable to prepare local speech."));
    await pending;
    expect(player.getSnapshot("response")).toMatchObject({
      status: "playing",
      progress: null,
      error: "Unable to prepare local speech.",
    });
    audios[0]!.finish();
    expect(player.getSnapshot("response")?.status).toBe("ended");
  });

  it("keeps prepared audio when autoplay is blocked, then plays on another gesture", async () => {
    let blocked = true;
    const { player, disposed } = setup();
    const play = TestAudio.prototype.play;
    TestAudio.prototype.play = async function (this: TestAudio) {
      if (blocked) throw new DOMException("Gesture required", "NotAllowedError");
      return play.call(this);
    };
    try {
      await player.start("response", { environmentId, text: "Hello.", voice: "af_heart" });
      expect(player.getSnapshot("response")).toMatchObject({
        status: "paused",
        error: "Speech is ready. Press Play to listen.",
      });
      expect(disposed()).toBe(0);
      blocked = false;
      await player.resume();
      expect(player.getSnapshot("response")).toMatchObject({ status: "playing", error: null });
    } finally {
      TestAudio.prototype.play = play;
    }
  });
});
