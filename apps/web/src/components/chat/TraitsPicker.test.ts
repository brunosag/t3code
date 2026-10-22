import { buildTraitsTriggerDisplay } from "@t3tools/client-runtime/model-traits";
import { describe, expect, it } from "vite-plus/test";
import {
  ProviderInstanceId,
  ProviderDriverKind,
  type ProviderOptionDescriptor,
} from "@t3tools/contracts";
import { shouldRenderTraitsControls } from "./TraitsPicker";

function selectDescriptor(
  id: string,
  options: ReadonlyArray<{ id: string; label: string; isDefault?: boolean }>,
  currentValue: string,
): Extract<ProviderOptionDescriptor, { type: "select" }> {
  return { id, label: id, type: "select", options: [...options], currentValue };
}

function fastModeDescriptor(
  currentValue: boolean,
): Extract<ProviderOptionDescriptor, { type: "boolean" }> {
  return { id: "fastMode", label: "Fast Mode", type: "boolean", currentValue };
}

describe("Claude auto-compaction control", () => {
  const descriptor = {
    id: "autoCompact",
    label: "Auto-compact",
    type: "select" as const,
    options: [
      { id: "default", label: "Default", isDefault: true },
      { id: "on", label: "On" },
      { id: "off", label: "Off" },
    ],
  };

  it("keeps compaction controls out of model options", () => {
    expect(
      shouldRenderTraitsControls({
        provider: ProviderDriverKind.make("claudeAgent"),
        models: [
          {
            slug: "custom",
            name: "Custom",
            isCustom: true,
            capabilities: { optionDescriptors: [descriptor] },
          },
        ],
        model: "custom",
        promptUltrathink: "none",
        modelOptions: undefined,
        planModeEnabled: false,
      }),
    ).toBe(false);
  });

  it.each([
    ["default", ""],
    ["on", ""],
    ["off", ""],
  ])("labels the %s override without adding the default to the composer", (currentValue, label) => {
    expect(
      buildTraitsTriggerDisplay({
        provider: ProviderDriverKind.make("claudeAgent"),
        descriptors: [{ ...descriptor, currentValue }],
        primarySelectDescriptorId: descriptor.id,
        ultrathinkPromptControlled: false,
      }),
    ).toEqual({ label });
  });
});

function serviceTierDescriptor(
  currentValue: "default" | "priority" | "ultrafast" | "flex",
): Extract<ProviderOptionDescriptor, { type: "select" }> {
  return {
    id: "serviceTier",
    label: "Service Tier",
    type: "select",
    options: [
      { id: "default", label: "Standard", isDefault: true },
      { id: "priority", label: "Fast" },
      { id: "ultrafast", label: "Ultrafast" },
      { id: "flex", label: "Flex" },
    ],
    currentValue,
  };
}

const EFFORT = selectDescriptor(
  "reasoningEffort",
  [
    { id: "high", label: "High" },
    { id: "max", label: "Max" },
  ],
  "high",
);
const CONTEXT_WINDOW = selectDescriptor(
  "contextWindow",
  [
    { id: "200k", label: "200k" },
    { id: "1m", label: "1M" },
  ],
  "1m",
);

const CODEX = ProviderDriverKind.make("codex");

function display(descriptors: ReadonlyArray<ProviderOptionDescriptor>) {
  return buildTraitsTriggerDisplay({
    provider: CODEX,
    descriptors,
    primarySelectDescriptorId: "reasoningEffort",
    ultrathinkPromptControlled: false,
  });
}
