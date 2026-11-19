import { describe, expect, it } from "@effect/vitest";

import { encodeWav, prepareSpeechText, SPEECH_SAMPLE_RATE, splitSpeechText } from "./speechText.ts";

describe("prepareSpeechText", () => {
  it("speaks underscores and hyphens between letters as spaces, keeping digit ranges", () => {
    expect(prepareSpeechText("(n, l, m_l, m_s) and ΔH_f via read-aloud, 10-20 items")).toBe(
      "(n, l, m l, m s) and ΔH f via read aloud, 10-20 items",
    );
  });
});

describe("splitSpeechText", () => {
  it("splits sentences and lines, and long sentences at word boundaries", () => {
    const longSentence = Array.from({ length: 60 }, (_, index) => `word${index}`).join(" ");
    const chunks = splitSpeechText(`First one. Second one?\nThird line\n\n${longSentence}`);
    expect(chunks.slice(0, 3)).toEqual(["First one.", "Second one?", "Third line"]);
    const rest = chunks.slice(3);
    expect(rest.length).toBeGreaterThan(1);
    expect(rest.every((chunk) => chunk.length <= 180)).toBe(true);
    expect(rest.join(" ")).toBe(longSentence);
  });

  it("cuts a long first sentence at its first clause so playback starts sooner", () => {
    expect(
      splitSpeechText(
        "Yes, the usage command now pools each provider's quota, the way the Usage page does. Next.",
      ),
    ).toEqual([
      "Yes, the usage command now pools each provider's quota,",
      "the way the Usage page does.",
      "Next.",
    ]);
    const unbroken = "A long first sentence without any clause break that runs well past sixty.";
    expect(splitSpeechText(unbroken)).toEqual([unbroken]);
  });
});

describe("encodeWav", () => {
  it("writes a 16-bit mono WAV at the model's sample rate, clamping samples", () => {
    const wav = encodeWav(new Float32Array([0, 1, -1, 2]));
    const view = new DataView(wav.buffer);
    const ascii = (offset: number) => String.fromCharCode(...wav.subarray(offset, offset + 4));
    expect([ascii(0), ascii(8), ascii(12), ascii(36)]).toEqual(["RIFF", "WAVE", "fmt ", "data"]);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(SPEECH_SAMPLE_RATE);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(8);
    expect([0, 1, 2, 3].map((index) => view.getInt16(44 + index * 2, true))).toEqual([
      0, 32767, -32768, 32767,
    ]);
  });
});
