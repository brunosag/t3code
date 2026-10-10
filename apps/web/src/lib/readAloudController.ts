import type { EnvironmentId, ReadAloudVoice } from "@t3tools/contracts";

export interface SpeechRequest {
  /** The environment whose host generates the speech, normally the thread's own. */
  readonly environmentId: EnvironmentId;
  readonly text: string;
  readonly voice: ReadAloudVoice;
}

export interface SpeechGenerationProgress {
  readonly label: string;
  readonly percent: number | null;
}

/** One generated piece of a response, playable while later pieces are still generating. */
export interface SpeechChunk {
  readonly blob: Blob;
  /** Seconds, known from the sample count before the audio element loads metadata. */
  readonly duration: number;
}

export interface ReadAloudState {
  readonly messageKey: string;
  /** `buffering` means playback caught up with generation and resumes when the next chunk lands. */
  readonly status: "preparing" | "playing" | "buffering" | "paused" | "ended" | "error";
  readonly position: number;
  readonly duration: number;
  readonly speed: number;
  /** Non-null while generation is still running, including during playback. */
  readonly progress: SpeechGenerationProgress | null;
  readonly error: string | null;
}

type PlaybackAudio = EventTarget &
  Pick<HTMLAudioElement, "currentTime" | "playbackRate" | "paused" | "ended" | "play" | "pause">;

export interface ReadAloudBackend {
  /** Resolves once every chunk has been delivered through `onChunk`. */
  readonly generate: (
    request: SpeechRequest,
    signal: AbortSignal,
    onProgress: (progress: SpeechGenerationProgress) => void,
    onChunk: (chunk: SpeechChunk) => void,
  ) => Promise<void>;
  readonly createPlayback: (blob: Blob) => {
    readonly audio: PlaybackAudio;
    readonly dispose: () => void;
  };
}

interface Segment {
  readonly playback: ReturnType<ReadAloudBackend["createPlayback"]>;
  /** Offset of this chunk within the whole response, in seconds. */
  readonly start: number;
  readonly duration: number;
  readonly detach: () => void;
}

/** Owns one response at a time, independent of virtualized message row lifetimes. */
export class ReadAloudController {
  private readonly backend: ReadAloudBackend;
  private readonly listeners = new Set<() => void>();
  private state: ReadAloudState | null = null;
  private generation: AbortController | null = null;
  private segments: Segment[] = [];
  private current = 0;
  // Whether the user wants sound, as opposed to whether a chunk is playing right now.
  private wantsPlayback = false;
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
    for (const segment of this.segments) {
      segment.detach();
      segment.playback.audio.pause();
      segment.playback.dispose();
    }
    this.segments = [];
    this.current = 0;
    this.wantsPlayback = false;
  }

  private sync() {
    const segment = this.segments[this.current];
    if (!segment) return;
    const { audio } = segment.playback;
    const last = this.current === this.segments.length - 1;
    // Status follows intent, so switching between chunks never flashes "paused".
    let status: ReadAloudState["status"];
    if (audio.ended && last && !this.generation) {
      status = "ended";
      // A finished response waits for Play instead of resuming on the next seek.
      this.wantsPlayback = false;
    } else if (!this.wantsPlayback) {
      status = "paused";
    } else {
      status = audio.ended && last ? "buffering" : "playing";
    }
    const time = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
    const end = this.segments.at(-1)!;
    this.update({
      status,
      position: segment.start + Math.min(time, segment.duration),
      duration: end.start + end.duration,
    });
  }

  private async play(segment: Segment): Promise<void> {
    try {
      await segment.playback.audio.play();
    } catch (error) {
      if (this.segments[this.current] !== segment) return;
      if (error instanceof Error && error.name === "NotAllowedError") {
        this.wantsPlayback = false;
        this.sync();
        this.update({ error: "Speech is ready. Press Play to listen." });
      } else if (!(error instanceof Error && error.name === "AbortError")) {
        this.fail();
      }
    }
  }

  private fail() {
    this.release();
    this.update({ status: "error", error: "Unable to play the generated speech.", progress: null });
  }

  /** Moves to the next chunk when the current one finishes, if it has been generated yet. */
  private advance() {
    const next = this.segments[this.current + 1];
    if (next && this.wantsPlayback) {
      this.current += 1;
      next.playback.audio.currentTime = 0;
      this.sync();
      void this.play(next);
      return;
    }
    this.sync();
  }

  private append(chunk: SpeechChunk): Promise<void> | undefined {
    const index = this.segments.length;
    const previous = this.segments.at(-1);
    const playback = this.backend.createPlayback(chunk.blob);
    const { audio } = playback;
    audio.playbackRate = this.speed;
    const isCurrent = () => this.current === index;
    const onPlaying = () => {
      if (!isCurrent()) return;
      this.wantsPlayback = true;
      this.sync();
    };
    const onPause = () => {
      if (!isCurrent()) return;
      // Reaching the end of a chunk also pauses it; only a real pause changes intent.
      if (!audio.ended) this.wantsPlayback = false;
      this.sync();
    };
    const onTimeUpdate = () => {
      if (isCurrent()) this.sync();
    };
    const onEnded = () => {
      if (isCurrent()) this.advance();
    };
    const onError = () => {
      if (isCurrent()) this.fail();
    };
    audio.addEventListener("playing", onPlaying);
    audio.addEventListener("pause", onPause);
    audio.addEventListener("timeupdate", onTimeUpdate);
    audio.addEventListener("ended", onEnded);
    audio.addEventListener("error", onError);
    const segment: Segment = {
      playback,
      start: previous ? previous.start + previous.duration : 0,
      duration: chunk.duration,
      detach: () => {
        audio.removeEventListener("playing", onPlaying);
        audio.removeEventListener("pause", onPause);
        audio.removeEventListener("timeupdate", onTimeUpdate);
        audio.removeEventListener("ended", onEnded);
        audio.removeEventListener("error", onError);
      },
    };
    this.segments.push(segment);
    const caughtUp =
      previous !== undefined && this.current === index - 1 && previous.playback.audio.ended;
    if (caughtUp) this.current = index;
    this.sync();
    if (this.wantsPlayback && (index === 0 || caughtUp)) return this.play(segment);
    return undefined;
  }

  async start(messageKey: string, request: SpeechRequest): Promise<void> {
    this.release();
    const generation = new AbortController();
    this.generation = generation;
    this.wantsPlayback = true;
    this.publish({
      messageKey,
      status: "preparing",
      position: 0,
      duration: 0,
      speed: this.speed,
      progress: { label: "Preparing local speech…", percent: null },
      error: null,
    });
    const plays: Promise<void>[] = [];
    try {
      if (!request.text.trim()) throw new Error("This response has no text suitable for speech.");
      await this.backend.generate(
        request,
        generation.signal,
        (progress) => {
          if (!generation.signal.aborted) this.update({ progress });
        },
        // Aborted backends can still deliver chunks. Never let them reach newer playback.
        (chunk) => {
          if (generation.signal.aborted) return;
          const play = this.append(chunk);
          if (play) plays.push(play);
        },
      );
      if (generation.signal.aborted) return;
      this.generation = null;
      if (this.segments.length === 0)
        throw new Error("This response has no text suitable for speech.");
      this.update({ progress: null });
      this.sync();
    } catch (error) {
      if (generation.signal.aborted) return;
      this.generation = null;
      const message = error instanceof Error ? error.message : "Unable to generate local speech.";
      if (this.segments.length === 0) {
        this.release();
        this.update({ status: "error", progress: null, error: message });
      } else {
        // Keep whatever was already generated playable.
        this.update({ progress: null, error: message });
        this.sync();
      }
    }
    await Promise.all(plays);
  }

  pause(): void {
    this.wantsPlayback = false;
    this.segments[this.current]?.playback.audio.pause();
    this.sync();
  }

  async resume(): Promise<void> {
    let segment = this.segments[this.current];
    if (!segment) return;
    this.update({ error: null });
    this.wantsPlayback = true;
    if (segment.playback.audio.ended) {
      const next = this.segments[this.current + 1];
      if (next) {
        this.current += 1;
      } else if (this.generation) {
        // Still generating: wait for the next chunk, which plays as soon as it arrives.
        this.sync();
        return;
      } else {
        this.current = 0;
      }
      segment = this.segments[this.current]!;
      segment.playback.audio.currentTime = 0;
    }
    await this.play(segment);
  }

  seek(position: number): void {
    const previous = this.segments[this.current];
    const end = this.segments.at(-1);
    if (!previous || !end || !Number.isFinite(position)) return;
    const target = Math.max(0, Math.min(end.start + end.duration, position));
    const index = this.segments.findIndex((segment) => target < segment.start + segment.duration);
    this.current = index === -1 ? this.segments.length - 1 : index;
    const segment = this.segments[this.current]!;
    if (segment !== previous) previous.playback.audio.pause();
    segment.playback.audio.currentTime = target - segment.start;
    this.sync();
    if (this.wantsPlayback && segment.playback.audio.paused && !segment.playback.audio.ended) {
      void this.play(segment);
    }
  }

  setSpeed(speed: number): void {
    if (!Number.isFinite(speed) || speed < 0.5 || speed > 2) return;
    this.speed = speed;
    for (const segment of this.segments) segment.playback.audio.playbackRate = speed;
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
