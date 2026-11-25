import { READ_ALOUD_SEEK_SECONDS, readAloud } from "../lib/readAloud";
import { type CommandHandler, registerCommands } from "./dispatcher";

const control =
  (act: () => void, { repeats = false } = {}): CommandHandler =>
  (event) => {
    if (!readAloud.getSnapshot()) return false;
    event.preventDefault();
    event.stopPropagation();
    if (repeats || !event.repeat) act();
  };

/**
 * Playback keys work on every route, since playback outlives its thread. The chat view takes
 * `readAloud.toggle` first when nothing is loaded, to start the thread's latest reply.
 */
export function installReadAloudCommands(): () => void {
  return registerCommands(
    {
      "readAloud.toggle": control(() => readAloud.togglePlayback()),
      "readAloud.stop": control(() => readAloud.stop()),
      "readAloud.seekBackward": control(() => readAloud.seekBy(-READ_ALOUD_SEEK_SECONDS), {
        repeats: true,
      }),
      "readAloud.seekForward": control(() => readAloud.seekBy(READ_ALOUD_SEEK_SECONDS), {
        repeats: true,
      }),
      "readAloud.slower": control(() => readAloud.stepSpeed(-1)),
      "readAloud.faster": control(() => readAloud.stepSpeed(1)),
    },
    { context: () => ({ readAloudActive: readAloud.getSnapshot() !== null }) },
  );
}
