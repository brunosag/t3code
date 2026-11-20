export interface ReadAloudTimelineProps {
  /** Seconds, shown at the thumb; the dragged value while scrubbing. */
  readonly position: number;
  /** Seconds the track spans, which may include audio still being generated. */
  readonly length: number;
  /** Seconds generated so far: the furthest point the thumb can reach. */
  readonly seekable: number;
  /** Spoken position, such as "0:12 of 1:30". */
  readonly valueLabel: string;
  /** The dragged position, or null when the drag ends. */
  readonly onScrub: (position: number | null) => void;
  readonly onSeek: (position: number) => void;
}

/** Accessibility increments and decrements move by this many seconds. */
export const READ_ALOUD_SKIP_SECONDS = 10;
