export interface SpeechGenerationProgress {
  readonly label: string;
  readonly percent: number | null;
}

export interface ReadAloudState {
  readonly messageKey: string;
  readonly status: "preparing" | "playing" | "paused" | "ended" | "error";
  readonly position: number;
  readonly duration: number;
  readonly speed: number;
  readonly progress: SpeechGenerationProgress | null;
  readonly error: string | null;
}

type PlaybackAudio = EventTarget &
  Pick<
    HTMLAudioElement,
    "currentTime" | "duration" | "playbackRate" | "paused" | "ended" | "play" | "pause"
  >;

export interface ReadAloudBackend {
  readonly generate: (
    text: string,
    signal: AbortSignal,
    onProgress: (progress: SpeechGenerationProgress) => void,
  ) => Promise<Blob>;
  readonly createPlayback: (blob: Blob) => {
    readonly audio: PlaybackAudio;
    readonly dispose: () => void;
  };
}

/** Owns one response at a time, independent of virtualized message row lifetimes. */
export class ReadAloudController {
  private readonly backend: ReadAloudBackend;
  private readonly listeners = new Set<() => void>();
  private state: ReadAloudState | null = null;
  private generation: AbortController | null = null;
  private playback: ReturnType<ReadAloudBackend["createPlayback"]> | null = null;
  private detachPlayback: (() => void) | null = null;
  private speed = 1;

  constructor(backend: ReadAloudBackend) {
    this.backend = backend;
  }

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot(messageKey?: string): ReadAloudState | null {
    return messageKey === undefined || this.state?.messageKey === messageKey ? this.state : null;
  }

  private publish(state: ReadAloudState | null) {
    this.state = state;
    for (const listener of this.listeners) listener();
  }

  private update(patch: Partial<ReadAloudState>) {
    if (this.state) this.publish({ ...this.state, ...patch });
  }

  private release() {
    this.generation?.abort();
    this.generation = null;
    this.detachPlayback?.();
    this.detachPlayback = null;
    this.playback?.audio.pause();
    this.playback?.dispose();
    this.playback = null;
  }

  async start(messageKey: string, text: string): Promise<void> {
    this.release();
    const generation = new AbortController();
    this.generation = generation;
    this.publish({
      messageKey,
      status: "preparing",
      position: 0,
      duration: 0,
      speed: this.speed,
      progress: { label: "Preparing local speech…", percent: null },
      error: null,
    });
    try {
      if (!text.trim()) throw new Error("This response has no text suitable for speech.");
      const blob = await this.backend.generate(text, generation.signal, (progress) => {
        if (!generation.signal.aborted) this.update({ progress });
      });
      // Aborted backends can still finish. Never let their result replace newer playback.
      if (generation.signal.aborted) return;
      const playback = this.backend.createPlayback(blob);
      this.playback = playback;
      const { audio } = playback;
      audio.playbackRate = this.speed;
      const sync = () => {
        if (generation.signal.aborted) return;
        this.update({
          status: audio.ended ? "ended" : audio.paused ? "paused" : "playing",
          position: Number.isFinite(audio.currentTime) ? audio.currentTime : 0,
          duration: Number.isFinite(audio.duration) ? audio.duration : 0,
          progress: null,
        });
      };
      const onError = () => {
        if (generation.signal.aborted) return;
        this.release();
        this.update({
          status: "error",
          error: "Unable to play the generated speech.",
          progress: null,
        });
      };
      const events = [
        "playing",
        "pause",
        "timeupdate",
        "durationchange",
        "loadedmetadata",
        "ended",
      ];
      for (const event of events) audio.addEventListener(event, sync);
      audio.addEventListener("error", onError);
      this.detachPlayback = () => {
        for (const event of events) audio.removeEventListener(event, sync);
        audio.removeEventListener("error", onError);
      };
      sync();
      await this.resume();
    } catch (error) {
      if (generation.signal.aborted) return;
      this.release();
      this.update({
        status: "error",
        progress: null,
        error: error instanceof Error ? error.message : "Unable to generate local speech.",
      });
    }
  }

  pause(): void {
    this.playback?.audio.pause();
  }

  async resume(): Promise<void> {
    const playback = this.playback;
    if (!playback) return;
    this.update({ error: null });
    if (playback.audio.ended) playback.audio.currentTime = 0;
    try {
      await playback.audio.play();
    } catch (error) {
      if (this.playback !== playback) return;
      if (error instanceof Error && error.name === "NotAllowedError") {
        this.update({ status: "paused", error: "Speech is ready. Press Play to listen." });
      } else if (!(error instanceof Error && error.name === "AbortError")) {
        this.release();
        this.update({ status: "error", error: "Unable to play the generated speech." });
      }
    }
  }

  seek(position: number): void {
    const audio = this.playback?.audio;
    if (!audio || !Number.isFinite(position) || !Number.isFinite(audio.duration)) return;
    audio.currentTime = Math.max(0, Math.min(audio.duration, position));
    this.update({ position: audio.currentTime, status: audio.paused ? "paused" : "playing" });
  }

  setSpeed(speed: number): void {
    if (!Number.isFinite(speed) || speed < 0.5 || speed > 2) return;
    this.speed = speed;
    if (this.playback) this.playback.audio.playbackRate = speed;
    this.update({ speed });
  }

  stop(): void {
    this.release();
    this.publish(null);
  }

  stopMessage(messageKey: string): void {
    if (this.state?.messageKey === messageKey) this.stop();
  }
}
