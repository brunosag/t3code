import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { PiMessage, piMessageText, piModelSelection } from "./PiProtocol.ts";

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
});
