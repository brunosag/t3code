import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import {
  PiMessage,
  PiSideChannelMessage,
  PiState,
  PiThinkingLevels,
  piMessageText,
  piModelSelection,
} from "./PiProtocol.ts";

const decodeSideChannel = Schema.decodeUnknownSync(PiSideChannelMessage);

describe("Pi protocol translation", () => {
  it("tolerates the removed default selection and preserves slashes in explicit model IDs", () => {
    expect(piModelSelection("default")).toBeUndefined();
    expect(piModelSelection("custom/vendor/model")).toEqual({
      provider: "custom",
      modelId: "vendor/model",
    });
    for (const value of ["", "bare-model", "/model", "provider/"]) {
      expect(() => piModelSelection(value)).toThrow("provider/modelId");
    }
  });

  it("extracts text without exposing reasoning, tool arguments, or images", () => {
    const message = Schema.decodeUnknownSync(PiMessage)({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "private reasoning" },
        { type: "text", text: "Hello " },
        { type: "toolCall", arguments: { secret: "not output" } },
        { type: "image", data: "base64" },
        { type: "text", text: "world" },
      ],
    });
    expect(piMessageText(message)).toBe("Hello world");
    expect(piMessageText({ role: "assistant", content: "plain text" })).toBe("plain text");
    expect(piMessageText({ role: "assistant" })).toBe("");
  });

  it("decodes thinking levels and tolerates a Pi build that does not report one", () => {
    const decodeState = Schema.decodeUnknownSync(PiState);
    const decodeThinkingLevels = Schema.decodeSync(PiThinkingLevels);
    const base = { sessionId: "pi-session-1", isStreaming: false };
    expect(decodeState({ ...base, thinkingLevel: "xhigh" }).thinkingLevel).toBe("xhigh");
    expect(decodeState(base).thinkingLevel).toBeUndefined();
    expect(() => decodeState({ ...base, thinkingLevel: "turbo" })).toThrow();
    expect(decodeThinkingLevels({ levels: ["off", "max"] }).levels).toEqual(["off", "max"]);
  });

  it("decodes a settled subagent activity from the extension channel", () => {
    expect(
      decodeSideChannel({
        type: "subagent.activity",
        event: "failed",
        agentId: "agent-7",
        agentType: "researcher",
        description: "Check sources",
        status: "error",
        error: "boom",
        toolUses: 0,
        durationMs: 12,
        tokens: { input: 10, output: 5, total: 15 },
      }),
    ).toMatchObject({ type: "subagent.activity", event: "failed", agentId: "agent-7" });
    // Everything past the event and id is optional: a run that spent nothing
    // omits its usage, and a completed run omits its error.
    expect(
      decodeSideChannel({ type: "subagent.activity", event: "completed", agentId: "agent-8" }),
    ).toMatchObject({ event: "completed" });
  });
});
