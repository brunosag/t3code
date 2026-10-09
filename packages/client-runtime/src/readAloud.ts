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

function inlineText(node: SpeechNode): string {
  if (node.data?.codexFileCitationMarkdown) return " ";
  if (node.type === "link" && (node.children ?? []).every((child) => child.value === node.url)) {
    return " ";
  }
  switch (node.type) {
    case "text":
      return node.value ?? "";
    case "break":
      return " ";
    case "emphasis":
    case "strong":
    case "link":
    case "linkReference":
      return (node.children ?? []).map(inlineText).join("");
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
