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
  const source = markdown
    .replace(/^::artifact-template\b.*$/gm, "")
    .replace(/<(details|script|style|oai-mem-citation)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/\\\([\s\S]*?\\\)|\\\[[\s\S]*?\\\]/g, " ");
  visit(parser.runSync(parser.parse(source)));
  return blocks.join("\n\n");
}

export interface ReadAloudVoiceInfo {
  readonly name: string;
  readonly accent: "American" | "British";
  readonly gender: "Female" | "Male";
  /** Kokoro's published overall grade; lower grades sound noticeably less natural. */
  readonly grade: string;
}

/** Display metadata mirrored from kokoro-js, which is too heavy to import outside the speech worker. */
export const READ_ALOUD_VOICE_INFO: Record<ReadAloudVoice, ReadAloudVoiceInfo> = {
  af_heart: { name: "Heart", accent: "American", gender: "Female", grade: "A" },
  af_alloy: { name: "Alloy", accent: "American", gender: "Female", grade: "C" },
  af_aoede: { name: "Aoede", accent: "American", gender: "Female", grade: "C+" },
  af_bella: { name: "Bella", accent: "American", gender: "Female", grade: "A-" },
  af_jessica: { name: "Jessica", accent: "American", gender: "Female", grade: "D" },
  af_kore: { name: "Kore", accent: "American", gender: "Female", grade: "C+" },
  af_nicole: { name: "Nicole", accent: "American", gender: "Female", grade: "B-" },
  af_nova: { name: "Nova", accent: "American", gender: "Female", grade: "C" },
  af_river: { name: "River", accent: "American", gender: "Female", grade: "D" },
  af_sarah: { name: "Sarah", accent: "American", gender: "Female", grade: "C+" },
  af_sky: { name: "Sky", accent: "American", gender: "Female", grade: "C-" },
  am_adam: { name: "Adam", accent: "American", gender: "Male", grade: "F+" },
  am_echo: { name: "Echo", accent: "American", gender: "Male", grade: "D" },
  am_eric: { name: "Eric", accent: "American", gender: "Male", grade: "D" },
  am_fenrir: { name: "Fenrir", accent: "American", gender: "Male", grade: "C+" },
  am_liam: { name: "Liam", accent: "American", gender: "Male", grade: "D" },
  am_michael: { name: "Michael", accent: "American", gender: "Male", grade: "C+" },
  am_onyx: { name: "Onyx", accent: "American", gender: "Male", grade: "D" },
  am_puck: { name: "Puck", accent: "American", gender: "Male", grade: "C+" },
  am_santa: { name: "Santa", accent: "American", gender: "Male", grade: "D-" },
  bf_alice: { name: "Alice", accent: "British", gender: "Female", grade: "D" },
  bf_emma: { name: "Emma", accent: "British", gender: "Female", grade: "B-" },
  bf_isabella: { name: "Isabella", accent: "British", gender: "Female", grade: "C" },
  bf_lily: { name: "Lily", accent: "British", gender: "Female", grade: "D" },
  bm_daniel: { name: "Daniel", accent: "British", gender: "Male", grade: "D" },
  bm_fable: { name: "Fable", accent: "British", gender: "Male", grade: "C" },
  bm_george: { name: "George", accent: "British", gender: "Male", grade: "C" },
  bm_lewis: { name: "Lewis", accent: "British", gender: "Male", grade: "D+" },
};

export const READ_ALOUD_VOICE_GROUPS = (
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
}));
