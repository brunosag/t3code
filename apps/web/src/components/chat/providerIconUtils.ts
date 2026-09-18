import { ProviderDriverKind } from "@t3tools/contracts";
import { type ModelVendor, resolveModelVendor } from "@t3tools/client-runtime/state/model-vendor";
import {
  AntigravityIcon,
  ClaudeAI,
  CursorIcon,
  DeepSeekIcon,
  Gemini,
  GrokIcon,
  Icon,
  MeituanIcon,
  MetaIcon,
  MiniMaxIcon,
  MistralIcon,
  MoonshotIcon,
  OpenAI,
  OpenCodeIcon,
  PiIcon,
  QwenIcon,
  XiaomiIcon,
} from "../Icons";

export const PROVIDER_ICON_BY_PROVIDER: Partial<Record<ProviderDriverKind, Icon>> = {
  [ProviderDriverKind.make("codex")]: OpenAI,
  [ProviderDriverKind.make("claudeAgent")]: ClaudeAI,
  [ProviderDriverKind.make("opencode")]: OpenCodeIcon,
  [ProviderDriverKind.make("cursor")]: CursorIcon,
  [ProviderDriverKind.make("grok")]: GrokIcon,
  [ProviderDriverKind.make("antigravity")]: AntigravityIcon,
  [ProviderDriverKind.make("pi")]: PiIcon,
};

const VENDOR_ICON_BY_VENDOR: Partial<Record<ModelVendor, Icon>> = {
  openai: OpenAI,
  anthropic: ClaudeAI,
  google: Gemini,
  meta: MetaIcon,
  xai: GrokIcon,
  deepseek: DeepSeekIcon,
  qwen: QwenIcon,
  moonshot: MoonshotIcon,
  minimax: MiniMaxIcon,
  mistral: MistralIcon,
  xiaomi: XiaomiIcon,
  meituan: MeituanIcon,
};

/**
 * Glyph to show in place of the provider glyph, or `undefined` to keep the
 * provider glyph.
 *
 * When a single provider instance is configured, its mark repeats on every row
 * and identifies nothing; the model's vendor is the useful signal instead. With
 * several instances configured the provider mark is what tells them apart, so
 * it always wins. Vendors without a glyph fall back the same way.
 */
export function resolveModelVendorIcon(
  model: { readonly slug?: string | undefined; readonly name?: string | undefined } | null,
  isSoleProviderInstance: boolean,
): Icon | undefined {
  if (!isSoleProviderInstance) return undefined;
  const vendor = resolveModelVendor(model);
  return vendor ? VENDOR_ICON_BY_VENDOR[vendor] : undefined;
}

export type ModelEsque = {
  slug: string;
  name: string;
  shortName?: string | undefined;
  subProvider?: string | undefined;
  aliases?: ReadonlyArray<string> | undefined;
  isDefault?: boolean | undefined;
  badge?: "new" | undefined;
  isLegacy?: boolean | undefined;
  isUnavailable?: boolean | undefined;
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripLeadingQualifier(value: string, qualifier: string | null | undefined): string {
  const trimmedQualifier = qualifier?.trim();
  if (!trimmedQualifier) {
    return value;
  }

  const pattern = new RegExp(`^${escapeRegExp(trimmedQualifier)}(?:\\s*[.:/-]\\s*|\\s+)`, "iu");
  return value.replace(pattern, "").trim() || value;
}

export function getDisplayModelName(
  model: ModelEsque,
  options?: { preferShortName?: boolean },
): string {
  const name = options?.preferShortName && model.shortName ? model.shortName : model.name;
  return stripLeadingQualifier(name, model.subProvider);
}

export function getTriggerDisplayModelName(model: ModelEsque): string {
  return getDisplayModelName(model, { preferShortName: true });
}

export function getTriggerDisplayModelLabel(model: ModelEsque): string {
  return getTriggerDisplayModelName(model);
}
