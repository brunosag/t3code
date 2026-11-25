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
  const sentence = (index: number) => `Sentence ${index} says a little more about the topic.`;

  it("keeps sentences whole, in chunks no longer than the speech before them", () => {
    const text = Array.from({ length: 60 }, (_, index) => sentence(index)).join(" ");
    const chunks = splitSpeechText(text);
    expect(chunks.join(" ")).toBe(text);
    expect(chunks.every((chunk) => /^Sentence \d+ .*topic\.$/.test(chunk))).toBe(true);
    expect(chunks[0]).toBe(sentence(0));
    let before = 0;
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(Math.min(1000, Math.max(120, before)));
      before += chunk.length;
    }
    expect(chunks.length).toBeLessThan(12);
  });

  it("closes lines without punctuation so headings and list items keep their pause", () => {
    expect(splitSpeechText("Intro line here.\nA heading\n\nFirst item: details\nDone!")).toEqual([
      "Intro line here.",
      "A heading. First item: details. Done!",
    ]);
  });

  it("cuts only a sentence too long for one chunk, at a clause or word", () => {
    const clause = Array.from({ length: 30 }, (_, index) => `word${index} more`).join(" ");
    const long = Array.from({ length: 8 }, () => clause).join(", ");
    const chunks = splitSpeechText(`Start here. ${long}.`);
    expect(chunks.slice(1).every((chunk) => chunk.length <= 1000)).toBe(true);
    expect(chunks.slice(1, -1).every((chunk) => chunk.endsWith(","))).toBe(true);
    expect(chunks.join(" ")).toBe(`Start here. ${long}.`);
  });

  it("cuts a long first sentence at its first clause so playback starts sooner", () => {
    const first =
      "Yes, the usage command now pools each provider's quota, the way the Usage page does it, and prints the totals for each account.";
    expect(splitSpeechText(`${first} Next.`)).toEqual([
      "Yes, the usage command now pools each provider's quota,",
      "the way the Usage page does it, and prints the totals for each account. Next.",
    ]);
    const short = "A first sentence with a clause, but short enough to keep.";
    expect(splitSpeechText(short)).toEqual([short]);
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
