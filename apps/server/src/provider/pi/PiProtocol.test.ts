import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import {
  PiMessage,
  PiState,
  PiThinkingLevels,
  piMessageText,
  piModelSelection,
} from "./PiProtocol.ts";

describe("Pi protocol translation", () => {
  it("leaves the runtime default unchanged and preserves slashes in explicit model IDs", () => {
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
});
