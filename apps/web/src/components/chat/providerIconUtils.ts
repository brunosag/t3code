import { ProviderDriverKind } from "@t3tools/contracts";
import {
  type ModelVendor,
  resolveModelVendorGlyph,
} from "@t3tools/client-runtime/state/model-vendor";
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

/** Glyph(s) a model row draws instead of the plain provider glyph. */
export type ModelVendorGlyph = {
  /** Model vendor mark replacing the provider mark. */
  readonly icon: Icon;
  /** Provider mark stamped over the icon's bottom-right corner. */
  readonly overlayIcon?: Icon | undefined;
};

/**
 * Glyph(s) for a model row, or `undefined` to keep the plain provider glyph.
 *
 * The vendor mark replaces the provider mark when a single provider instance
 * is configured (its mark repeats on every row and identifies nothing), and —
 * with several active providers — for Pi models, whose rows would otherwise
 * all carry the same mark: those show the vendor mark with the Pi mark
 * overlaid. Every other provider keeps its mark so it stays tellable apart
 * from the rest. See `resolveModelVendorGlyph` for the shared rule.
 */
export function resolveModelVendorIcon(
  model: { readonly slug?: string | undefined; readonly name?: string | undefined } | null,
  driverKind: ProviderDriverKind | null | undefined,
  isSoleProviderInstance: boolean,
): ModelVendorGlyph | undefined {
  const { vendor, overlayProvider } = resolveModelVendorGlyph({
    model,
    driverKind,
    isSoleProviderInstance,
  });
  if (!vendor) return undefined;
  const icon = VENDOR_ICON_BY_VENDOR[vendor];
  if (!icon) return undefined;
  const providerIcon = driverKind ? PROVIDER_ICON_BY_PROVIDER[driverKind] : undefined;
  return overlayProvider && providerIcon ? { icon, overlayIcon: providerIcon } : { icon };
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
