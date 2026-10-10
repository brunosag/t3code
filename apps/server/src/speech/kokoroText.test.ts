import { describe, expect, it } from "@effect/vitest";

import {
  encodeWav,
  fitPhonemes,
  KOKORO_SAMPLE_RATE,
  modelInputIds,
  normalizeText,
  phonemeSections,
  splitSpeechText,
  tokenize,
} from "./kokoroText.ts";

describe("normalizeText", () => {
  it("spells out money, times, years, decimals, ranges, and titles", () => {
    expect(normalizeText("Dr. Smith paid $12.50 at 3:05.")).toBe(
      "Doctor Smith paid 12 dollars and 50 cents at 3 oh 5.",
    );
    expect(normalizeText("In 1984 it cost £1 for 10-20 items.")).toBe(
      "In 19 84 it cost 1 pound for 10 to 20 items.",
    );
    expect(normalizeText("Roughly 2.75 times.")).toBe("Roughly 2 point 7 5 times.");
  });
});

describe("phonemeSections", () => {
  it("keeps punctuation out of phonemization", () => {
    expect(phonemeSections("Hello, world!")).toEqual([
      { punctuation: false, text: "Hello" },
      { punctuation: true, text: ", " },
      { punctuation: false, text: "world" },
      { punctuation: true, text: "!" },
    ]);
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
});

describe("tokenization", () => {
  const vocab = new Map([
    ["a", 1],
    ["b", 2],
    [" ", 3],
  ]);

  it("drops symbols outside the vocabulary and adds boundary tokens", () => {
    expect(tokenize("a?b", vocab)).toEqual([1, 2]);
    expect(modelInputIds("ab", vocab)).toEqual([0, 1, 2, 0]);
  });

  it("splits phonemes that exceed the model context at spaces", () => {
    const phonemes = Array.from({ length: 400 }, () => "ab").join(" ");
    const pieces = fitPhonemes(phonemes, vocab);
    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.every((piece) => tokenize(piece, vocab).length <= 510)).toBe(true);
    expect(pieces.join(" ")).toBe(phonemes);
    expect(fitPhonemes("ab ab", vocab)).toEqual(["ab ab"]);
  });
});

describe("encodeWav", () => {
  it("writes a 16-bit mono WAV at the model's sample rate, clamping samples", () => {
    const wav = encodeWav(new Float32Array([0, 1, -1, 2]));
    const view = new DataView(wav.buffer);
    const ascii = (offset: number) => String.fromCharCode(...wav.subarray(offset, offset + 4));
    expect([ascii(0), ascii(8), ascii(12), ascii(36)]).toEqual(["RIFF", "WAVE", "fmt ", "data"]);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(KOKORO_SAMPLE_RATE);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(8);
    expect([0, 1, 2, 3].map((index) => view.getInt16(44 + index * 2, true))).toEqual([
      0, 32767, -32768, 32767,
    ]);
  });
});
