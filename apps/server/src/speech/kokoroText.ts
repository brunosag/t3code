// Text preparation for the Kokoro-82M speech model.
//
// `normalizeText`, `phonemeSections`, `finishPhonemes`, and the number and
// currency helpers are ported from kokoro.js 1.2.1 (https://github.com/hexgrad/kokoro, Apache-2.0,
// Copyright hexgrad and Xenova) so the server can drive ONNX Runtime directly
// instead of loading transformers.js, which also pulls in sharp and the web
// runtime. Keep them behaviorally identical: the model was trained on exactly
// this normalization.
export const KOKORO_SAMPLE_RATE = 24_000;
/** Kokoro's context is 512 tokens, including the two boundary tokens. */
const MAX_PHONEME_TOKENS = 510;
/** Short chunks keep the wait before the first audio, and between later chunks, small. */
const MAX_CHUNK_CHARS = 180;

function splitNumber(match: string): string {
  if (match.includes(".")) return match;
  if (match.includes(":")) {
    const [hours, minutes] = match.split(":").map(Number) as [number, number];
    if (minutes === 0) return `${hours} o'clock`;
    if (minutes < 10) return `${hours} oh ${minutes}`;
    return `${hours} ${minutes}`;
  }
  const year = Number.parseInt(match.slice(0, 4), 10);
  if (year < 1100 || year % 1000 < 10) return match;
  const left = match.slice(0, 2);
  const right = Number.parseInt(match.slice(2, 4), 10);
  const suffix = match.endsWith("s") ? "s" : "";
  if (year % 1000 >= 100 && year % 1000 <= 999) {
    if (right === 0) return `${left} hundred${suffix}`;
    if (right < 10) return `${left} oh ${right}${suffix}`;
  }
  return `${left} ${right}${suffix}`;
}

function flipMoney(match: string): string {
  const bill = match[0] === "$" ? "dollar" : "pound";
  if (Number.isNaN(Number(match.slice(1)))) return `${match.slice(1)} ${bill}s`;
  if (!match.includes(".")) {
    const plural = match.slice(1) === "1" ? "" : "s";
    return `${match.slice(1)} ${bill}${plural}`;
  }
  const [whole, fraction = ""] = match.slice(1).split(".");
  const cents = Number.parseInt(fraction.padEnd(2, "0"), 10);
  const coins =
    match[0] === "$" ? (cents === 1 ? "cent" : "cents") : cents === 1 ? "penny" : "pence";
  return `${whole} ${bill}${whole === "1" ? "" : "s"} and ${cents} ${coins}`;
}

function pointNumber(match: string): string {
  const [whole, fraction = ""] = match.split(".");
  return `${whole} point ${fraction.split("").join(" ")}`;
}

export function normalizeText(text: string): string {
  return (
    text
      .replace(/[‘’]/g, "'")
      .replace(/«/g, "“")
      .replace(/»/g, "”")
      .replace(/[“”]/g, '"')
      .replace(/\(/g, "«")
      .replace(/\)/g, "»")
      .replace(/、/g, ", ")
      .replace(/。/g, ". ")
      .replace(/！/g, "! ")
      .replace(/，/g, ", ")
      .replace(/：/g, ": ")
      .replace(/；/g, "; ")
      .replace(/？/g, "? ")
      .replace(/[^\S \n]/g, " ")
      // Upstream replaces only the first run of spaces; matching it keeps tokens identical.
      .replace(/  +/, " ")
      .replace(/(?<=\n) +(?=\n)/g, "")
      .replace(/\bD[Rr]\.(?= [A-Z])/g, "Doctor")
      .replace(/\b(?:Mr\.|MR\.(?= [A-Z]))/g, "Mister")
      .replace(/\b(?:Ms\.|MS\.(?= [A-Z]))/g, "Miss")
      .replace(/\b(?:Mrs\.|MRS\.(?= [A-Z]))/g, "Mrs")
      .replace(/\betc\.(?! [A-Z])/gi, "etc")
      .replace(/\b(y)eah?\b/gi, "$1e'a")
      .replace(/\d*\.\d+|\b\d{4}s?\b|(?<!:)\b(?:[1-9]|1[0-2]):[0-5]\d\b(?!:)/g, splitNumber)
      .replace(/(?<=\d),(?=\d)/g, "")
      .replace(
        /[$£]\d+(?:\.\d+)?(?: hundred| thousand| (?:[bm]|tr)illion)*\b|[$£]\d+\.\d\d?\b/gi,
        flipMoney,
      )
      .replace(/\d*\.\d+/g, pointNumber)
      .replace(/(?<=\d)-(?=\d)/g, " to ")
      .replace(/(?<=\d)S/g, " S")
      .replace(/(?<=[BCDFGHJ-NP-TV-Z])'?s\b/g, "'S")
      .replace(/(?<=X')S\b/g, "s")
      .replace(/(?:[A-Za-z]\.){2,} [a-z]/g, (match) => match.replace(/\./g, "-"))
      .replace(/(?<=[A-Z])\.(?=[A-Z])/gi, "-")
      .trim()
  );
}

const PUNCTUATION = ';:,.!?¡¿—…"«»“”(){}[]';
const PUNCTUATION_RUN = new RegExp(
  `(\\s*[${PUNCTUATION.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}]+\\s*)+`,
  "g",
);

interface PhonemeSection {
  readonly punctuation: boolean;
  readonly text: string;
}

/** Kokoro voices are named `<accent><gender>_<name>`; `a` is American English, `b` British. */
export function phonemeLanguage(voice: string): "en-us" | "en" {
  return voice.startsWith("a") ? "en-us" : "en";
}

/**
 * Normalizes text and splits it around punctuation. Only sections with
 * `punctuation: false` go through espeak; punctuation is kept verbatim.
 */
export function phonemeSections(text: string): PhonemeSection[] {
  const normalized = normalizeText(text);
  const sections: PhonemeSection[] = [];
  let cursor = 0;
  for (const match of normalized.matchAll(PUNCTUATION_RUN)) {
    if (cursor < match.index) {
      sections.push({ punctuation: false, text: normalized.slice(cursor, match.index) });
    }
    if (match[0].length > 0) sections.push({ punctuation: true, text: match[0] });
    cursor = match.index + match[0].length;
  }
  if (cursor < normalized.length) {
    sections.push({ punctuation: false, text: normalized.slice(cursor) });
  }
  return sections;
}

/** Joins phonemized sections and maps espeak's symbols onto Kokoro's. */
export function finishPhonemes(sections: ReadonlyArray<string>, voice: string): string {
  let processed = sections
    .join("")
    .replace(/kəkˈoːɹoʊ/g, "kˈoʊkəɹoʊ")
    .replace(/kəkˈɔːɹəʊ/g, "kˈəʊkəɹəʊ")
    .replace(/ʲ/g, "j")
    .replace(/r/g, "ɹ")
    .replace(/x/g, "k")
    .replace(/ɬ/g, "l")
    .replace(/(?<=[a-zɹː])(?=hˈʌndɹɪd)/g, " ")
    .replace(/ z(?=[;:,.!?¡¿—…"«»“” ]|$)/g, "z");
  if (voice.startsWith("a")) processed = processed.replace(/(?<=nˈaɪn)ti(?!ː)/g, "di");
  return processed.trim();
}

/**
 * Phoneme symbols outside the vocabulary are dropped, as Kokoro's tokenizer normalizer does.
 * Use `modelInputIds` for the model's input, which also needs the boundary tokens.
 */
export function tokenize(phonemes: string, vocab: ReadonlyMap<string, number>): number[] {
  const ids: number[] = [];
  for (const symbol of phonemes) {
    const id = vocab.get(symbol);
    if (id !== undefined) ids.push(id);
  }
  return ids;
}

export function modelInputIds(phonemes: string, vocab: ReadonlyMap<string, number>): number[] {
  return [0, ...tokenize(phonemes, vocab), 0];
}

/**
 * Splits phonemes into pieces that fit the model's context, at spaces where possible.
 * Kokoro's own pipeline truncates instead, which silently drops the end of long sentences.
 */
export function fitPhonemes(phonemes: string, vocab: ReadonlyMap<string, number>): string[] {
  if (tokenize(phonemes, vocab).length <= MAX_PHONEME_TOKENS) return [phonemes];
  const middle = Math.floor(phonemes.length / 2);
  const space = phonemes.lastIndexOf(" ", middle);
  const split = space > 0 ? space : middle;
  return [
    ...fitPhonemes(phonemes.slice(0, split), vocab),
    ...fitPhonemes(phonemes.slice(split).trimStart(), vocab),
  ];
}

/** Splits text into sentence-sized chunks so playback can start before the whole text is ready. */
export function splitSpeechText(text: string): string[] {
  const chunks: string[] = [];
  for (const sentence of text.split(/(?<=[.!?])\s+|\n+/)) {
    let remaining = sentence.trim();
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
  view.setUint32(24, KOKORO_SAMPLE_RATE, true);
  view.setUint32(28, KOKORO_SAMPLE_RATE * 2, true);
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
