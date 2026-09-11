import type { ModelCapabilities } from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";

import type { PiThinkingLevel } from "./PiProtocol.ts";

const PI_THINKING_LEVEL_LABELS: Record<PiThinkingLevel, string> = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
};

/**
 * Builds the traits a Pi model exposes from Pi's own report. A model that can
 * only run `off` has no reasoning choice worth showing, so it gets no descriptor
 * and the composer renders no picker for it.
 */
export const mapPiThinkingCapabilities = (
  levels: ReadonlyArray<PiThinkingLevel>,
  currentLevel: PiThinkingLevel | undefined,
): ModelCapabilities | null => {
  if (!levels.some((level) => level !== "off")) return null;
  return createModelCapabilities({
    optionDescriptors: [
      {
        id: "reasoningEffort",
        label: "Reasoning",
        type: "select",
        options: levels.map((level) => ({ id: level, label: PI_THINKING_LEVEL_LABELS[level] })),
        ...(currentLevel ? { currentValue: currentLevel } : {}),
      },
    ],
  });
};
