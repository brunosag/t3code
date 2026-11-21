import { speechInputFromMarkdown } from "@t3tools/client-runtime/read-aloud";
import { DEFAULT_UNIFIED_SETTINGS, type EnvironmentId, type ThreadId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { memo, useSyncExternalStore } from "react";
import { Pressable, type ColorValue } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { appAtomRegistry } from "../../state/atom-registry";
import { mobilePreferencesAtom } from "../../state/preferences";
import { readAloud, readAloudMessageKey } from "./readAloud";

function readAloudVoice() {
  const preferences = appAtomRegistry.get(mobilePreferencesAtom);
  return (
    (AsyncResult.isSuccess(preferences) ? preferences.value.readAloudVoice : undefined) ??
    DEFAULT_UNIFIED_SETTINGS.readAloudVoice
  );
}

export const ReadAloudButton = memo(function ReadAloudButton(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly messageId: string;
  readonly markdown: string;
  readonly tintColor: ColorValue;
  readonly buttonSize: number;
  readonly iconSize: number;
}) {
  const key = readAloudMessageKey(props.environmentId, props.threadId, props.messageId);
  const state = useSyncExternalStore(readAloud.subscribe, () => readAloud.getSnapshot(key));
  if (!props.markdown.trim()) return null;
  const active = state !== null && state.status !== "error";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={active ? "Stop reading aloud" : "Read aloud"}
      hitSlop={8}
      onPress={() => {
        if (active) {
          readAloud.stopMessage(key);
          return;
        }
        void readAloud.start(key, {
          environmentId: props.environmentId,
          ...speechInputFromMarkdown(props.markdown),
          voice: readAloudVoice(),
        });
      }}
      style={({ pressed }) => ({
        width: props.buttonSize,
        height: props.buttonSize,
        alignItems: "center",
        justifyContent: "center",
        opacity: pressed ? 0.52 : 1,
      })}
    >
      <SymbolView
        name={active ? "stop.fill" : "speaker.wave.2"}
        size={props.iconSize}
        tintColor={props.tintColor}
        type="monochrome"
      />
    </Pressable>
  );
});
