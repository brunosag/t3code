import { READ_ALOUD_SPEEDS } from "@t3tools/client-runtime/read-aloud-controller";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useState, useSyncExternalStore } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { Menu } from "../../components/ui/Menu";
import { useThreadShell } from "../../state/entities";
import { useOpenLinkedThread } from "../threads/useOpenLinkedThread";
import { readAloud, readAloudSourceThread } from "./readAloud";
import { ReadAloudTimeline } from "./ReadAloudTimeline";

const getSnapshot = () => readAloud.getSnapshot();

function formatTime(seconds: number) {
  const value = Math.floor(seconds);
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")}`;
}

function ControlButton(props: {
  readonly label: string;
  readonly icon: "play" | "pause" | "xmark";
  readonly disabled?: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      accessibilityState={{ disabled: Boolean(props.disabled) }}
      disabled={props.disabled}
      hitSlop={6}
      onPress={props.onPress}
      className="size-9 items-center justify-center active:opacity-60"
      style={props.disabled ? { opacity: 0.4 } : undefined}
    >
      <SymbolView name={props.icon} size={18} tintColorClassName="accent-foreground" />
    </Pressable>
  );
}

/**
 * Sits above the composer so playback stays controllable after its message scrolls away.
 * Playback outlives the thread it came from, so every thread shows it with a link back.
 */
export function ReadAloudPlayer(props: { readonly threadRef: ScopedThreadRef }) {
  const state = useSyncExternalStore(readAloud.subscribe, getSnapshot);
  const source = state ? readAloudSourceThread(state.messageKey) : null;
  const otherThread =
    source !== null &&
    (source.environmentId !== props.threadRef.environmentId ||
      source.threadId !== props.threadRef.threadId)
      ? source
      : null;
  const sourceShell = useThreadShell(otherThread);
  const openThread = useOpenLinkedThread();
  // The dragged position while the user scrubs, so playback ticks don't move the thumb back.
  const [scrub, setScrub] = useState<number | null>(null);

  if (!state) return null;
  const preparing = state.status === "preparing";
  // Buffering still means the user asked to listen, so it offers Pause.
  const playing = state.status === "playing" || state.status === "buffering";
  const playable = !preparing && state.status !== "error";
  // While generating, the total spans the estimated response, so new sentences don't rescale it.
  const estimate = state.progress?.estimatedDuration ?? null;
  const length = Math.max(state.duration, estimate ?? 0);
  const total = !state.progress
    ? formatTime(length)
    : estimate === null
      ? "–:––"
      : `~${formatTime(length)}`;
  const status =
    state.error ??
    (preparing
      ? `${state.progress?.label ?? "Preparing speech…"}${
          state.progress?.percent != null ? ` ${state.progress.percent}%` : ""
        }`
      : null);

  return (
    <View accessibilityLabel="Read aloud" className="gap-1 px-4 pb-2">
      <View className="flex-row items-center gap-2">
        <SymbolView name="speaker.wave.2" size={14} tintColorClassName="accent-foreground-muted" />
        {otherThread ? (
          <Pressable
            accessibilityRole="link"
            onPress={() => openThread(otherThread)}
            className="max-w-[40%] shrink active:opacity-60"
          >
            <Text className="text-xs text-foreground" numberOfLines={1}>
              {sourceShell?.title?.trim() || "Other thread"}
            </Text>
          </Pressable>
        ) : null}
        <Text
          accessibilityLiveRegion="polite"
          className="min-w-0 flex-1 text-xs tabular-nums text-foreground-muted"
          numberOfLines={1}
        >
          {status ?? `${formatTime(scrub ?? state.position)} / ${total}`}
        </Text>
        <Menu
          title="Reading speed"
          actions={READ_ALOUD_SPEEDS.map((speed) => ({
            id: String(speed),
            title: `${speed}×`,
            state: speed === state.speed ? "on" : "off",
          }))}
          onPressAction={({ nativeEvent }) => readAloud.setSpeed(Number(nativeEvent.event))}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Reading speed, ${state.speed}×`}
            className="h-9 min-w-9 items-center justify-center px-1 active:opacity-60"
          >
            <Text className="text-xs font-t3-medium tabular-nums text-foreground">
              {state.speed}×
            </Text>
          </Pressable>
        </Menu>
        <ControlButton
          label={playing ? "Pause reading" : "Play reading"}
          icon={playing ? "pause" : "play"}
          disabled={!playable}
          onPress={() => {
            if (playing) readAloud.pause();
            else void readAloud.resume();
          }}
        />
        <ControlButton label="Stop reading" icon="xmark" onPress={() => readAloud.stop()} />
      </View>
      {playable && length > 0 ? (
        <ReadAloudTimeline
          position={scrub ?? state.position}
          length={length}
          seekable={state.duration}
          valueLabel={`${formatTime(scrub ?? state.position)} of ${total}`}
          onScrub={setScrub}
          onSeek={(position) => readAloud.seek(position)}
        />
      ) : null}
    </View>
  );
}
