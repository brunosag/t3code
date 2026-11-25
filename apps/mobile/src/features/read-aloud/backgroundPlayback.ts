import type {
  ReadAloudController,
  ReadAloudState,
} from "@t3tools/client-runtime/read-aloud-controller";

export interface AnchorPlayer {
  play(): void;
  pause(): void;
  addListener(
    event: "playbackStatusUpdate",
    listener: (status: { readonly playing: boolean; readonly isBuffering: boolean }) => void,
  ): { remove(): void };
  /** Releases the player along with its notification and media session. */
  release(): void;
}

// Status updates still reporting the state from before our last command.
const ECHO_SECONDS = 1;

/**
 * Android keeps a backgrounded app's audio, JavaScript and connection alive only under a media
 * foreground service, which Expo Audio ties to one lock-screen player. Speech uses a player per
 * sentence, so a silent looping anchor holds the service; its media controls drive read aloud.
 */
export function keepReadAloudInBackground(
  controller: Pick<ReadAloudController, "subscribe" | "getSnapshot" | "pause" | "resume">,
  options: {
    /** Called while the app is in the foreground, which Android requires to start the service. */
    readonly createAnchor: (state: ReadAloudState) => AnchorPlayer;
    /** Claims the audio session, so it plays in the background before the first sentence lands. */
    readonly claim: () => Promise<void>;
    readonly now?: () => number;
  },
): () => void {
  const now = options.now ?? (() => performance.now() / 1000);
  let anchor: { player: AnchorPlayer; detach: () => void } | null = null;
  let playing = false;
  let commandedAt = -Infinity;
  // Resume publishes the paused state once more before its sentence starts playing.
  let following = false;

  const command = (play: boolean) => {
    if (!anchor || play === playing) return;
    playing = play;
    commandedAt = now();
    if (!play) {
      anchor.player.pause();
      return;
    }
    const current = anchor;
    options.claim().then(
      () => {
        if (anchor !== current || !playing) return;
        commandedAt = now();
        current.player.play();
      },
      () => {},
    );
  };

  const release = () => {
    if (!anchor) return;
    anchor.detach();
    anchor.player.release();
    anchor = null;
    playing = false;
  };

  const sync = () => {
    if (following) return;
    const state = controller.getSnapshot();
    if (!state || state.status === "ended" || state.status === "error") {
      release();
      return;
    }
    if (!anchor) {
      const player = options.createAnchor(state);
      const subscription = player.addListener("playbackStatusUpdate", (status) => {
        if (status.playing === playing || status.isBuffering) return;
        if (now() - commandedAt < ECHO_SECONDS) return;
        // The notification, lock screen, a headset button or another app's audio moved it.
        playing = status.playing;
        following = true;
        try {
          if (status.playing) void controller.resume();
          else controller.pause();
        } finally {
          following = false;
        }
      });
      anchor = { player, detach: () => subscription.remove() };
    }
    command(state.status !== "paused");
  };

  const unsubscribe = controller.subscribe(sync);
  sync();
  return () => {
    unsubscribe();
    release();
  };
}
