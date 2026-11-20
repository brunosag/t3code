import { Progress } from "../../components/ui/Progress";
import type { ReadAloudTimelineProps } from "./ReadAloudTimeline.types";

// The fork's app ships on Android only, where the timeline is a slider.
export function ReadAloudTimeline(props: ReadAloudTimelineProps) {
  return <Progress value={props.position / props.length} label="Reading position" />;
}
