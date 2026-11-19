// Text preparation for Phonon, which spells out numbers, amounts and symbols itself.
export const SPEECH_SAMPLE_RATE = 24_000;
/** Each chunk plays as its own clip, so chunks end at sentences or clauses. */
const MAX_CHUNK_CHARS = 180;
/** A long first sentence is cut at a clause, so playback starts sooner. */
const FIRST_CHUNK_CHARS = 60;
/** Phonon's speaking rate in English, for an estimate before any audio exists. */
const CHARACTERS_PER_SECOND = 15;

/**
 * Phonon reads underscores aloud and runs hyphenated words together ("read-aloud" becomes
 * one word), so both become spaces. Hyphens between digits stay: Phonon reads ranges.
 */
export function prepareSpeechText(text: string): string {
  return text
    .replace(/(?<=[\p{L}\p{N}])_+(?=[\p{L}\p{N}])/gu, " ")
    .replace(/(?<=\p{L})-(?=\p{L})/gu, " ");
}

function splitFirstClause(sentence: string): string[] {
  if (sentence.length <= FIRST_CHUNK_CHARS) return [sentence];
  const clause = /[,;:]\s/g;
  for (const match of sentence.matchAll(clause)) {
    if (match.index < 20) continue;
    if (match.index >= MAX_CHUNK_CHARS) break;
    return [sentence.slice(0, match.index + 1), sentence.slice(match.index + 2)];
  }
  return [sentence];
}

/** Splits text into sentence-sized chunks so playback can start before the whole text is ready. */
export function splitSpeechText(text: string): string[] {
  const chunks: string[] = [];
  for (const sentence of text.split(/(?<=[.!?])\s+|\n+/)) {
    let remaining = sentence.trim();
    if (chunks.length === 0 && remaining) {
      const [first, rest] = splitFirstClause(remaining);
      if (rest !== undefined) {
        chunks.push(first!);
        remaining = rest;
      }
    }
    while (remaining.length > MAX_CHUNK_CHARS) {
      const space = remaining.lastIndexOf(" ", MAX_CHUNK_CHARS);
      const end = space > 0 ? space : MAX_CHUNK_CHARS;
      chunks.push(remaining.slice(0, end));
      remaining = remaining.slice(end).trim();
    }
    if (remaining) chunks.push(remaining);
  }
  return chunks;
}

/** Seconds of speech for `remaining`, at the rate generated so far once there is some. */
export function estimateRemainingSeconds(
  remaining: ReadonlyArray<string>,
  generated: { readonly characters: number; readonly seconds: number },
): number {
  const rate =
    generated.seconds > 0 ? generated.characters / generated.seconds : CHARACTERS_PER_SECOND;
  return remaining.reduce((total, chunk) => total + chunk.length, 0) / rate;
}

/** Encodes mono samples as a 16-bit PCM WAV file, half the size of the model's float output. */
export function encodeWav(samples: Float32Array): Uint8Array {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  const writeAscii = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index++) {
      view.setUint8(offset + index, value.charCodeAt(index));
    }
  };
  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, SPEECH_SAMPLE_RATE, true);
  view.setUint32(28, SPEECH_SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let index = 0; index < samples.length; index++) {
    const sample = Math.max(-1, Math.min(1, samples[index]!));
    view.setInt16(44 + index * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }
  return bytes;
}
