import { useEffect, useSyncExternalStore } from "react";
import { PauseIcon, PlayIcon, SquareIcon, Volume2Icon } from "lucide-react";
import { speechTextFromMarkdown } from "@t3tools/client-runtime/read-aloud";

import { getClientSettings } from "~/hooks/useSettings";
import { readAloud } from "~/lib/readAloud";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
const getServerSnapshot = () => null;

function messageKey(threadKey: string, messageId: string) {
  return `${threadKey}\0${messageId}`;
}

function formatTime(seconds: number) {
  const value = Math.floor(seconds);
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")}`;
}

export function ReadAloudButton({
  threadKey,
  messageId,
  text,
  streaming,
}: {
  threadKey: string;
  messageId: string;
  text: string;
  streaming: boolean;
}) {
  const key = messageKey(threadKey, messageId);
  const state = useSyncExternalStore(
    readAloud.subscribe,
    () => readAloud.getSnapshot(key),
    getServerSnapshot,
  );
  const active = state !== null && state.status !== "error";
  const label = active ? "Stop reading aloud" : "Read aloud";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="xs"
            variant="ghost-muted"
            aria-label={label}
            aria-pressed={active}
            disabled={streaming || !text.trim()}
            onClick={() => {
              if (active) readAloud.stopMessage(key);
              else {
                void readAloud.start(key, {
                  text: speechTextFromMarkdown(text),
                  voice: getClientSettings().readAloudVoice,
                });
              }
            }}
          />
        }
      >
        {active ? <SquareIcon className="size-3" /> : <Volume2Icon className="size-3" />}
      </TooltipTrigger>
      <TooltipPopup>{streaming ? "Read aloud when the response finishes" : label}</TooltipPopup>
    </Tooltip>
  );
}

/** Lives outside the virtualized list so playback stays controllable when a row scrolls away. */
export function ReadAloudPlayer({ threadKey }: { threadKey: string }) {
  const prefix = `${threadKey}\0`;
  const state = useSyncExternalStore(
    readAloud.subscribe,
    () => {
      const snapshot = readAloud.getSnapshot();
      return snapshot?.messageKey.startsWith(prefix) ? snapshot : null;
    },
    getServerSnapshot,
  );
  useEffect(
    () => () => {
      if (readAloud.getSnapshot()?.messageKey.startsWith(`${threadKey}\0`)) readAloud.stop();
    },
    [threadKey],
  );

  if (!state) return null;
  const preparing = state.status === "preparing";
  const playing = state.status === "playing";
  const playable = !preparing && state.status !== "error";
  return (
    <section
      aria-label="Read-aloud player"
      className="shrink-0 border-b border-border bg-background"
    >
      <div className="chat-content-lane flex flex-col gap-1.5 py-2">
        <div className="flex flex-wrap items-center gap-2">
          <Volume2Icon aria-hidden="true" className="size-3.5 text-muted-foreground" />
          <span className="text-xs font-medium">Read aloud</span>
          {playable ? (
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              aria-label={playing ? "Pause reading" : "Play reading"}
              onClick={() => {
                if (playing) readAloud.pause();
                else void readAloud.resume();
              }}
            >
              {playing ? <PauseIcon className="size-3" /> : <PlayIcon className="size-3" />}
            </Button>
          ) : null}
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            aria-label="Stop reading"
            onClick={() => readAloud.stop()}
          >
            <SquareIcon className="size-3" />
          </Button>
          <Select
            value={state.speed}
            onValueChange={(value) => {
              if (value !== null) readAloud.setSpeed(value);
            }}
          >
            <SelectTrigger size="compact" variant="ghost" aria-label="Reading speed">
              <SelectValue>{state.speed}×</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {SPEEDS.map((speed) => (
                <SelectItem key={speed} value={speed}>
                  {speed}×
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
          {playable ? (
            <span className="text-xs tabular-nums text-muted-foreground">
              {formatTime(state.position)} / {formatTime(state.duration)}
            </span>
          ) : null}
        </div>
        {preparing ? (
          <div className="flex flex-col gap-1 text-xs text-muted-foreground">
            <p role="status">
              {state.progress?.label}
              {state.progress?.percent !== null && state.progress?.percent !== undefined
                ? ` ${state.progress.percent}%`
                : ""}
            </p>
            <p>First use downloads the selected voice. Speech stays on this device.</p>
          </div>
        ) : null}
        {playable ? (
          <input
            type="range"
            aria-label="Seek within response"
            aria-valuetext={`${formatTime(state.position)} of ${formatTime(state.duration)}`}
            className="w-full min-w-0 accent-primary"
            min={0}
            max={state.duration || 1}
            step={0.1}
            value={state.position}
            disabled={state.duration === 0}
            onChange={(event) => readAloud.seek(Number(event.currentTarget.value))}
          />
        ) : null}
        {state.error ? (
          <p role="status" className="text-xs text-muted-foreground">
            {state.error}
          </p>
        ) : null}
      </div>
    </section>
  );
}
