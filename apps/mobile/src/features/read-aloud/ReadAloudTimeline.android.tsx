import { Slider } from "@expo/ui/jetpack-compose";
import { fillMaxWidth } from "@expo/ui/jetpack-compose/modifiers";
import { useRef } from "react";
import { View } from "react-native";

import { NativeThemeHost } from "../../components/ui/NativeThemeHost.android";
import { useControlTheme } from "../../components/ui/useControlTheme";
import { READ_ALOUD_SKIP_SECONDS, type ReadAloudTimelineProps } from "./ReadAloudTimeline.types";

export function ReadAloudTimeline(props: ReadAloudTimelineProps) {
  const { colors } = useControlTheme();
  const draft = useRef<number | null>(null);
  const seekBy = (seconds: number) =>
    props.onSeek(Math.max(0, Math.min(props.seekable, props.position + seconds)));
  return (
    <View
      accessible
      accessibilityLabel="Reading position"
      accessibilityRole="adjustable"
      accessibilityValue={{ text: props.valueLabel }}
      accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
      onAccessibilityAction={({ nativeEvent }) => {
        if (nativeEvent.actionName === "increment") seekBy(READ_ALOUD_SKIP_SECONDS);
        else if (nativeEvent.actionName === "decrement") seekBy(-READ_ALOUD_SKIP_SECONDS);
      }}
    >
      <View importantForAccessibility="no-hide-descendants">
        <NativeThemeHost style={{ height: 36, width: "100%" }}>
          <Slider
            min={0}
            max={props.length}
            upperLimit={props.seekable}
            value={Math.min(props.position, props.length)}
            modifiers={[fillMaxWidth()]}
            colors={{
              thumbColor: colors["--color-primary"],
              activeTrackColor: colors["--color-primary"],
              inactiveTrackColor: colors["--color-secondary"],
            }}
            onValueChange={(value) => {
              draft.current = value;
              props.onScrub(value);
            }}
            onValueChangeFinished={() => {
              const value = draft.current;
              draft.current = null;
              props.onScrub(null);
              if (value !== null) props.onSeek(value);
            }}
          />
        </NativeThemeHost>
      </View>
    </View>
  );
}
