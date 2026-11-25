import { useSyncExternalStore, type CSSProperties, type ReactElement } from "react";
import { useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import { PauseIcon, PlayIcon, SquareIcon, Volume2Icon } from "lucide-react";
import { parseScopedThreadKey } from "@t3tools/client-runtime/environment";
import { READ_ALOUD_SPEEDS } from "@t3tools/client-runtime/read-aloud-controller";
import type { KeybindingCommand, ResolvedKeybindingsConfig } from "@t3tools/contracts";

import { getClientSettings } from "~/hooks/useSettings";
import { shortcutLabelForCommand } from "~/keybindings";
import { READ_ALOUD_SEEK_SECONDS, readAloud } from "~/lib/readAloud";
import { useThreadShell } from "~/state/entities";
import { primaryServerKeybindingsAtom } from "~/state/server";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ComposerBanner } from "./ComposerBanner";

const getServerSnapshot = () => null;

function messageKey(threadKey: string, messageId: string) {
  return `${threadKey}\0${messageId}`;
}

/** Reads a reply aloud; false when it has no text or its thread is not on a server. */
export function startReadAloud(threadKey: string, messageId: string, text: string): boolean {
  const environmentId = parseScopedThreadKey(threadKey)?.environmentId;
  if (environmentId === undefined || !text.trim()) return false;
  // Loaded on demand so the remark parser stays out of the main web bundle.
  void import("@t3tools/client-runtime/read-aloud").then(({ speechInputFromMarkdown }) =>
    readAloud.start(messageKey(threadKey, messageId), {
      environmentId,
      ...speechInputFromMarkdown(text),
      voice: getClientSettings().readAloudVoice,
    }),
  );
  return true;
}

function shortcutLabel(keybindings: ResolvedKeybindingsConfig, command: KeybindingCommand) {
  return shortcutLabelForCommand(keybindings, command, {
    context: { terminalFocus: false, readAloudActive: true },
  });
}

function ShortcutTooltip(props: {
  label: string;
  shortcut: string | null;
  children: ReactElement;
}) {
  return (
    <Tooltip>
      <TooltipTrigger render={props.children} />
      <TooltipPopup side="top">
        {props.label}
        {props.shortcut ? ` (${props.shortcut})` : ""}
      </TooltipPopup>
    </Tooltip>
  );
}

function formatTime(seconds: number) {
  const value = Math.floor(seconds);
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")}`;
}

export function ReadAloudButton({
  threadKey,
  messageId,
  text,
}: {
  threadKey: string;
  messageId: string;
  text: string;
}) {
  const key = messageKey(threadKey, messageId);
  const environmentId = parseScopedThreadKey(threadKey)?.environmentId;
  const state = useSyncExternalStore(
    readAloud.subscribe,
    () => readAloud.getSnapshot(key),
    getServerSnapshot,
  );
  if (environmentId === undefined || !text.trim()) return null;
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
            onClick={() => {
              if (active) readAloud.stopMessage(key);
              else startReadAloud(threadKey, messageId, text);
            }}
          />
        }
      >
        {active ? (
          <SquareIcon className="size-3 fill-current" />
        ) : (
          <Volume2Icon className="size-3" />
        )}
      </TooltipTrigger>
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}

/**
 * Sits above the composer so playback stays controllable after its message scrolls away.
 * Playback outlives the thread it came from, so every thread shows it with a link back.
 */
export function ReadAloudPlayer({ threadKey }: { threadKey: string }) {
  const state = useSyncExternalStore(
    readAloud.subscribe,
    () => readAloud.getSnapshot(),
    getServerSnapshot,
  );
  const sourceThreadKey = state?.messageKey.slice(0, state.messageKey.indexOf("\0")) ?? null;
  const sourceRef =
    sourceThreadKey !== null && sourceThreadKey !== threadKey
      ? parseScopedThreadKey(sourceThreadKey)
      : null;
  const sourceShell = useThreadShell(sourceRef);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);

  if (!state) return null;
  const preparing = state.status === "preparing";
  // Buffering still means the user asked to listen, so it offers Pause.
  const playing = state.status === "playing" || state.status === "buffering";
  const playable = !preparing && state.status !== "error";
  // While generating, the bar spans the estimated response, so new sentences don't rescale it.
  const estimate = state.progress?.estimatedDuration ?? null;
  const length = Math.max(state.duration, estimate ?? 0);
  const total = !state.progress
    ? formatTime(length)
    : estimate === null
      ? "–:––"
      : `~${formatTime(length)}`;
  const ratio = length > 0 ? Math.min(1, state.position / length) : 0;
  const generated = length > 0 ? Math.min(1, state.duration / length) : 0;
  const seekStyle = {
    "--settings-slider-progress": `${ratio * 100}%`,
    "--settings-slider-fill-offset": `${0.5 - ratio}rem`,
    "--settings-slider-buffered-position": `calc(${generated * 100}% + ${0.5 - generated}rem)`,
  } as CSSProperties;

  return (
    <ComposerBanner.Attachment>
      <ComposerBanner.Root role="region" aria-label="Read aloud" density="comfortable">
        <ComposerBanner.Row>
          <ComposerBanner.Icon>
            <Volume2Icon />
          </ComposerBanner.Icon>
          <ComposerBanner.Content className="gap-2 text-muted-foreground tabular-nums">
            {sourceRef ? (
              <Link
                to="/$environmentId/$threadId"
                params={sourceRef}
                className="max-w-[40%] shrink-0 truncate text-foreground hover:underline"
              >
                {sourceShell?.title?.trim() || "Other thread"}
              </Link>
            ) : null}
            {state.error ? (
              <span role="status" className="truncate">
                {state.error}
              </span>
            ) : preparing ? (
              <span role="status" className="truncate">
                {state.progress?.label ?? "Preparing speech…"}
                {state.progress?.percent != null ? ` ${state.progress.percent}%` : ""}
              </span>
            ) : (
              <>
                <span>{formatTime(state.position)}</span>
                <input
                  type="range"
                  aria-label="Seek within response"
                  aria-valuetext={`${formatTime(state.position)} of ${total}`}
                  className="settings-slider min-w-0 flex-1"
                  min={0}
                  max={length || 1}
                  step={0.1}
                  value={state.position}
                  disabled={state.duration === 0}
                  style={seekStyle}
                  onChange={(event) => readAloud.seek(Number(event.currentTarget.value))}
                  onKeyDown={(event) => {
                    // The fine step keeps dragging smooth, but would make arrow keys move 0.1s.
                    const direction = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1 }[
                      event.key
                    ];
                    if (direction === undefined || event.altKey || event.ctrlKey || event.metaKey)
                      return;
                    event.preventDefault();
                    readAloud.seekBy(direction * READ_ALOUD_SEEK_SECONDS);
                  }}
                />
                <span>{total}</span>
              </>
            )}
          </ComposerBanner.Content>
          <ComposerBanner.Actions className="flex-nowrap">
            <Select
              value={state.speed}
              onValueChange={(value) => {
                if (value !== null) readAloud.setSpeed(value);
              }}
            >
              <SelectTrigger size="xs" variant="ghost" aria-label="Reading speed">
                <SelectValue>{state.speed}×</SelectValue>
              </SelectTrigger>
              <SelectPopup side="top">
                {READ_ALOUD_SPEEDS.map((speed) => (
                  <SelectItem key={speed} value={speed}>
                    {speed}×
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            <ShortcutTooltip
              label={playing ? "Pause reading" : "Play reading"}
              shortcut={shortcutLabel(keybindings, "readAloud.toggle")}
            >
              <Button
                type="button"
                size="icon-xs"
                variant="ghost-muted"
                aria-label={playing ? "Pause reading" : "Play reading"}
                disabled={!playable}
                onClick={() => {
                  if (playing) readAloud.pause();
                  else void readAloud.resume();
                }}
              >
                {playing ? <PauseIcon /> : <PlayIcon />}
              </Button>
            </ShortcutTooltip>
            <ShortcutTooltip
              label="Stop reading"
              shortcut={shortcutLabel(keybindings, "readAloud.stop")}
            >
              <ComposerBanner.Dismiss aria-label="Stop reading" onClick={() => readAloud.stop()} />
            </ShortcutTooltip>
          </ComposerBanner.Actions>
        </ComposerBanner.Row>
      </ComposerBanner.Root>
    </ComposerBanner.Attachment>
  );
}
