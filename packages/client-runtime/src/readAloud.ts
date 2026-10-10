import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { unified } from "unified";
import { remarkCodexDirectives } from "@t3tools/shared/codexMarkdownDirectives";

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

/** Extracts assistant prose only; callers must never pass work-log or tool output. */
export function speechTextFromMarkdown(markdown: string): string {
  const blocks: string[] = [];
  function visit(node: SpeechNode): void {
    switch (node.type) {
      case "paragraph":
      case "heading": {
        const text = (node.children ?? [])
          .map(inlineText)
          .join("")
          .replace(/\s+/g, " ")
          .replace(/\s+([,.!?;:])/g, "$1")
          .replace(/([,;:])\1+/g, "$1")
          .trim();
        if (/[\p{L}\p{N}]/u.test(text)) {
          blocks.push(/[.!?:;]$/.test(text) ? text : `${text}.`);
        }
        break;
      }
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
