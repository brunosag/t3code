import type { ReadAloudState } from "@t3tools/client-runtime/read-aloud-controller";
import { describe, expect, it } from "vite-plus/test";

import { keepReadAloudInBackground } from "./backgroundPlayback";

function setup() {
  let state: ReadAloudState | null = null;
  const listeners = new Set<() => void>();
  const calls: string[] = [];
  const publish = (status: ReadAloudState["status"] | null) => {
    state =
      status === null
        ? null
        : {
            messageKey: "thread\0message",
            status,
            position: 0,
            duration: 0,
            speed: 1,
            progress: null,
            error: null,
          };
    for (const listener of listeners) listener();
  };
  const controller = {
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    getSnapshot: () => state,
    pause: () => {
      calls.push("controller pause");
      publish("paused");
    },
    resume: async () => {
      calls.push("controller resume");
      // Like the real controller: one more paused publish before the sentence plays.
      publish("paused");
      publish("playing");
    },
  };
  let time = 0;
  let report!: (status: { playing: boolean; isBuffering: boolean }) => void;
  let claimed = Promise.resolve();
  const dispose = keepReadAloudInBackground(controller, {
    claim: () => {
      calls.push("claim");
      return (claimed = Promise.resolve());
    },
    now: () => time,
    createAnchor: (created) => {
      calls.push(`create ${created.status}`);
      return {
        play: () => calls.push("anchor play"),
        pause: () => calls.push("anchor pause"),
        addListener: (_event, listener) => {
          report = listener;
          return { remove: () => calls.push("removed") };
        },
        release: () => calls.push("anchor release"),
      };
    },
  });
  return {
    calls,
    publish,
    dispose,
    // Resolves after the anchor has reacted to the latest claim.
    settle: () => claimed.then(() => {}),
    advance: (seconds: number) => (time += seconds),
    anchor: (playing: boolean, isBuffering = false) => report({ playing, isBuffering }),
  };
}

describe("keepReadAloudInBackground", () => {
  it("holds a playing anchor for the whole listen and releases it when the listen ends", async () => {
    const { calls, publish, settle } = setup();
    publish("preparing");
    await settle();
    publish("playing");
    publish("buffering");
    publish("paused");
    publish("playing");
    await settle();
    publish("ended");
    expect(calls).toEqual([
      "create preparing",
      "claim",
      "anchor play",
      "anchor pause",
      "claim",
      "anchor play",
      "removed",
      "anchor release",
    ]);
  });

  it("turns notification, lock screen and headset play and pause into read-aloud ones", async () => {
    const { calls, publish, settle, advance, anchor } = setup();
    publish("playing");
    await settle();
    anchor(true);
    advance(5);
    anchor(false);
    expect(calls.slice(3)).toEqual(["controller pause"]);
    advance(5);
    anchor(true);
    expect(calls.slice(4)).toEqual(["controller resume"]);
  });

  it("ignores status updates echoing its own earlier commands", async () => {
    const { calls, publish, settle, advance, anchor } = setup();
    publish("playing");
    await settle();
    anchor(false);
    advance(5);
    anchor(true, true);
    publish("paused");
    anchor(true);
    expect(calls).toEqual(["create playing", "claim", "anchor play", "anchor pause"]);
  });

  it("stops holding the anchor when disposed or the listen is stopped", async () => {
    const stopped = setup();
    stopped.publish("playing");
    stopped.publish(null);
    expect(stopped.calls.slice(-2)).toEqual(["removed", "anchor release"]);

    const disposed = setup();
    disposed.publish("playing");
    disposed.dispose();
    disposed.publish("playing");
    expect(disposed.calls).toEqual(["create playing", "claim", "removed", "anchor release"]);
  });
});
