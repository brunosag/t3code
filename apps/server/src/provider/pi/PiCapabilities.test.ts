import { describe, expect, it } from "@effect/vitest";
import { mapPiThinkingCapabilities } from "./PiCapabilities.ts";

describe("Pi thinking capabilities", () => {
  it("turns Pi's reported levels into one reasoning selector in Pi's order", () => {
    const capabilities = mapPiThinkingCapabilities(
      ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
      "medium",
    );
    expect(capabilities).toEqual({
      optionDescriptors: [
        {
          id: "reasoningEffort",
          label: "Reasoning",
          type: "select",
          currentValue: "medium",
          options: [
            { id: "off", label: "Off" },
            { id: "minimal", label: "Minimal" },
            { id: "low", label: "Low" },
            { id: "medium", label: "Medium" },
            { id: "high", label: "High" },
            { id: "xhigh", label: "Extra High" },
            { id: "max", label: "Max" },
          ],
        },
      ],
    });
  });

  it("offers only the levels the model actually supports", () => {
    const descriptor = mapPiThinkingCapabilities(["off", "low", "high"], "high")
      ?.optionDescriptors?.[0];
    expect(
      descriptor?.type === "select" ? descriptor.options.map((option) => option.id) : [],
    ).toEqual(["off", "low", "high"]);
  });

  it("shows no selector for a model that cannot reason", () => {
    expect(mapPiThinkingCapabilities(["off"], "off")).toBeNull();
    expect(mapPiThinkingCapabilities([], undefined)).toBeNull();
  });

  it("omits the current value when Pi did not report one", () => {
    const descriptor = mapPiThinkingCapabilities(["off", "low"], undefined)?.optionDescriptors?.[0];
    expect(descriptor).not.toHaveProperty("currentValue");
  });
});
