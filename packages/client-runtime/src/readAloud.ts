import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { unified } from "unified";
import { remarkCodexDirectives } from "@t3tools/shared/codexMarkdownDirectives";
import { READ_ALOUD_VOICES, type ReadAloudVoice } from "@t3tools/contracts";

interface SpeechNode {
  readonly type: string;
  readonly value?: string;
  readonly url?: string;
  readonly data?:
    | {
        readonly codexArtifactTemplate?: unknown;
        readonly codexFileCitationMarkdown?: string;
      }
    | undefined;
  readonly children?: readonly SpeechNode[];
}

const parser = unified().use(remarkParse).use(remarkGfm).use(remarkMath).use(remarkCodexDirectives);

/**
 * Turns an inline code span or file name into words: paths become their last segment,
 * line suffixes and URLs are dropped, identifiers split at case changes, and dots
 * before a name are read as "dot". `src/lib/readAloud.ts:12` reads "read Aloud dot ts".
 */
function speakableCode(code: string): string {
  return code
    .split(/\s+/)
    .map((token) =>
      /^[a-z][a-z\d+.-]*:\/\//i.test(token)
        ? ""
        : token
            .replace(/(?<=[./][^/]*)(?::\d+(?:[-:]\d+)*|#L\d+(?:-L?\d+)?)$/, "")
            .replace(/\/+$/, "")
            .replace(/^.*\//, ""),
    )
    .join(" ")
    .replace(/(\p{Ll})(\p{Lu})/gu, "$1 $2")
    .replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, "$1 $2")
    .replace(/\.(?=[\p{L}\p{N}])/gu, " dot ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ");
}

function inlineText(node: SpeechNode): string {
  if (node.data?.codexFileCitationMarkdown) return " ";
  const children = node.children ?? [];
  if (node.type === "link" && children.every((child) => child.value === node.url)) {
    return " ";
  }
  switch (node.type) {
    case "text":
      return node.value ?? "";
    case "inlineCode":
      return ` ${speakableCode(node.value ?? "")} `;
    case "break":
      return " ";
    case "link":
    case "linkReference": {
      const label = children.map(inlineText).join("");
      // A one-word label such as `readAloud.ts:12` is usually a file name.
      return /^\S+$/.test(label.trim()) ? ` ${speakableCode(label.trim())} ` : label;
    }
    case "emphasis":
    case "strong":
      return children.map(inlineText).join("");
    default:
      return " ";
  }
}

function inlineContent(nodes: readonly SpeechNode[]): string {
  return nodes
    .map(inlineText)
    .join("")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.!?;:])/g, "$1")
    .replace(/([,;:])\1+/g, "$1")
    .trim();
}

const hasWords = (text: string) => /[\p{L}\p{N}]/u.test(text);

/**
 * Reads each body row as one sentence of "Header: value" pairs, so a row of
 * | File | Status | reads "File: main dot ts; Status: done."
 */
function tableRowSentences(table: SpeechNode): string[] {
  const [headerRow, ...bodyRows] = (table.children ?? []).map((row) =>
    (row.children ?? []).map((cell) => inlineContent(cell.children ?? []).replace(/[.,;:]+$/, "")),
  );
  return bodyRows.map((cells) =>
    cells
      .flatMap((cell, index) => {
        if (!hasWords(cell)) return [];
        const header = headerRow?.[index] ?? "";
        return [hasWords(header) ? `${header}: ${cell}` : cell];
      })
      .join("; "),
  );
}

/** The reply without what is never read aloud: artifact templates, collapsed details, citations. */
function speechMarkdown(markdown: string): string {
  return markdown
    .replace(/^::artifact-template\b.*$/gm, "")
    .replace(/<(details|script|style|oai-mem-citation)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
    .trim();
}

/** What to send to read `markdown` aloud: rule-based text, and the reply for a rewriting host. */
export function speechInputFromMarkdown(markdown: string): {
  readonly text: string;
  readonly markdown: string;
} {
  return { text: speechTextFromMarkdown(markdown), markdown: speechMarkdown(markdown) };
}

/** Extracts assistant prose only; callers must never pass work-log or tool output. */
export function speechTextFromMarkdown(markdown: string): string {
  const blocks: string[] = [];
  function pushSentence(text: string): void {
    if (hasWords(text)) blocks.push(/[.!?:;]$/.test(text) ? text : `${text}.`);
  }
  function visit(node: SpeechNode): void {
    switch (node.type) {
      case "paragraph":
      case "heading":
        pushSentence(inlineContent(node.children ?? []));
        break;
      case "table":
        for (const sentence of tableRowSentences(node)) pushSentence(sentence);
        break;
      case "root":
      case "blockquote":
      case "list":
      case "listItem":
        for (const child of node.children ?? []) visit(child);
        break;
    }
  }
  const source = speechMarkdown(markdown).replace(/\\\([\s\S]*?\\\)|\\\[[\s\S]*?\\\]/g, " ");
  visit(parser.runSync(parser.parse(source)));
  return blocks.join("\n\n");
}

export interface ReadAloudVoiceInfo {
  readonly name: string;
  /** Null for the model's own voice, which its catalog does not describe. */
  readonly accent: "American" | "British" | null;
  readonly gender: "Female" | "Male" | null;
}

/** Display metadata from the gradium/phonon-voices catalog. */
export const READ_ALOUD_VOICE_INFO: Record<ReadAloudVoice, ReadAloudVoiceInfo> = {
  default: { name: "Default", accent: null, gender: null },
  zoey: { name: "Zoey", accent: "American", gender: "Female" },
  juniper: { name: "Juniper", accent: "American", gender: "Female" },
  everly: { name: "Everly", accent: "American", gender: "Female" },
  harper: { name: "Harper", accent: "American", gender: "Female" },
  hadley: { name: "Hadley", accent: "American", gender: "Female" },
  delia: { name: "Delia", accent: "American", gender: "Female" },
  easton: { name: "Easton", accent: "American", gender: "Male" },
  micah: { name: "Micah", accent: "American", gender: "Male" },
  trevor: { name: "Trevor", accent: "American", gender: "Male" },
  russell: { name: "Russell", accent: "American", gender: "Male" },
  preston: { name: "Preston", accent: "American", gender: "Male" },
  miles: { name: "Miles", accent: "American", gender: "Male" },
  maeve: { name: "Maeve", accent: "British", gender: "Female" },
  freya: { name: "Freya", accent: "British", gender: "Female" },
  pippa: { name: "Pippa", accent: "British", gender: "Female" },
  "elodie-rose": { name: "Elodie-Rose", accent: "British", gender: "Female" },
  imogen: { name: "Imogen", accent: "British", gender: "Female" },
  lottie: { name: "Lottie", accent: "British", gender: "Female" },
  alfie: { name: "Alfie", accent: "British", gender: "Male" },
  hugh: { name: "Hugh", accent: "British", gender: "Male" },
  edwin: { name: "Edwin", accent: "British", gender: "Male" },
  spencer: { name: "Spencer", accent: "British", gender: "Male" },
  toby: { name: "Toby", accent: "British", gender: "Male" },
  teddy: { name: "Teddy", accent: "British", gender: "Male" },
  bryony: { name: "Bryony", accent: "British", gender: "Female" },
};

export function readAloudVoiceLabel(voice: ReadAloudVoice): string {
  const info = READ_ALOUD_VOICE_INFO[voice];
  return info.accent === null ? info.name : `${info.name} · ${info.accent}`;
}

export function readAloudVoicePreviewText(voice: ReadAloudVoice): string {
  const info = READ_ALOUD_VOICE_INFO[voice];
  const greeting = info.accent === null ? "" : `Hi, I'm ${info.name}. `;
  return `${greeting}This is how responses will sound when read aloud.`;
}

export const READ_ALOUD_VOICE_GROUPS = [
  {
    label: "Model",
    voices: READ_ALOUD_VOICES.filter((voice) => READ_ALOUD_VOICE_INFO[voice].accent === null),
  },
  ...(
    [
      ["American", "Female"],
      ["American", "Male"],
      ["British", "Female"],
      ["British", "Male"],
    ] as const
  ).map(([accent, gender]) => ({
    label: `${accent} ${gender.toLowerCase()}`,
    voices: READ_ALOUD_VOICES.filter(
      (voice) =>
        READ_ALOUD_VOICE_INFO[voice].accent === accent &&
        READ_ALOUD_VOICE_INFO[voice].gender === gender,
    ),
  })),
];
