/**
 * Maps a model to the company that trained it.
 *
 * A provider instance's `subProvider` is the gateway that serves the model
 * (`openai-codex`, `opencode-go`, `github`), not its vendor: one gateway
 * routinely fronts DeepSeek, Qwen, and Meta weights at once. So the vendor is
 * recovered from the model's own identity instead, matching the slug first and
 * the display name second.
 *
 * Adding a model from a vendor already listed here needs no change. Adding a
 * new vendor is one rule plus one glyph per client.
 *
 * @module state/modelVendor
 */

export type ModelVendor =
  | "openai"
  | "anthropic"
  | "google"
  | "meta"
  | "xai"
  | "deepseek"
  | "qwen"
  | "moonshot"
  | "minimax"
  | "mistral"
  | "xiaomi"
  | "meituan";

/**
 * Ordered vendor rules. Patterns match a normalized identity: lower-cased with
 * every run of non-alphanumerics collapsed to a single space, so `muse-spark-1.3`
 * and `Muse Spark 1.3` both read as `muse spark 1 3`.
 *
 * Patterns are anchored at the start because families are named by prefix; a
 * loose substring match would claim any third-party model with the family name
 * buried in it. The trailing `(?![a-z])` ends the family without requiring a
 * separator, since versions attach directly (`qwen3`, `llama4`).
 */
const VENDOR_RULES: ReadonlyArray<readonly [ModelVendor, RegExp]> = [
  ["openai", /^(?:gpt|chatgpt|codex|o[1-9]|sora|whisper)(?![a-z])/],
  ["anthropic", /^claude(?![a-z])/],
  ["google", /^(?:gemini|gemma|palm)(?![a-z])/],
  ["meta", /^(?:llama|muse spark)(?![a-z])/],
  ["xai", /^grok(?![a-z])/],
  ["deepseek", /^deepseek(?![a-z])/],
  ["qwen", /^(?:qwen|qwq|qvq)(?![a-z])/],
  ["moonshot", /^kimi(?![a-z])/],
  ["minimax", /^minimax(?![a-z])/],
  ["mistral", /^(?:mistral|mixtral|magistral|devstral|codestral|ministral)(?![a-z])/],
  ["xiaomi", /^mimo(?![a-z])/],
  ["meituan", /^longcat(?![a-z])/],
];

function normalizeModelIdentity(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function matchVendor(identity: string): ModelVendor | undefined {
  if (identity === "") return undefined;
  for (const [vendor, pattern] of VENDOR_RULES) {
    if (pattern.test(identity)) return vendor;
  }
  return undefined;
}

/**
 * Resolve the vendor for a model, or `undefined` when no rule claims it.
 *
 * The slug is matched on its last `/`-delimited segment so gateway-qualified
 * slugs (`opencode-go/muse-spark-1.3-contributor`) resolve on the model id
 * rather than the gateway name.
 */
export function resolveModelVendor(
  model: { readonly slug?: string | undefined; readonly name?: string | undefined } | null,
): ModelVendor | undefined {
  if (!model) return undefined;
  const slugTail = model.slug?.split("/").pop() ?? "";
  return (
    matchVendor(normalizeModelIdentity(slugTail)) ??
    matchVendor(normalizeModelIdentity(model.name ?? ""))
  );
}

/**
 * How a model's row draws its glyph: the vendor mark that replaces the
 * provider mark, and whether the provider mark overlays it.
 *
 * With a single usable provider its mark repeats on every row and identifies
 * nothing, so the model's vendor is the useful signal instead. With several
 * active providers the provider mark is normally what tells rows apart —
 * except Pi, whose models would otherwise all carry the same mark: those keep
 * the vendor mark with Pi stamped over its bottom-right corner, so a Pi row
 * stays as distinguishable as it is when Pi is the only active provider.
 *
 * `overlayProvider` is only true alongside a `vendor`, so a model with no
 * vendor rule keeps the plain provider mark rather than stamping it on itself.
 */
export function resolveModelVendorGlyph(input: {
  readonly model: {
    readonly slug?: string | undefined;
    readonly name?: string | undefined;
  } | null;
  readonly driverKind: string | null | undefined;
  readonly isSoleProviderInstance: boolean;
}): { readonly vendor: ModelVendor | undefined; readonly overlayProvider: boolean } {
  const vendor = resolveModelVendor(input.model);
  if (input.isSoleProviderInstance) return { vendor, overlayProvider: false };
  if (input.driverKind !== "pi" || vendor === undefined) {
    return { vendor: undefined, overlayProvider: false };
  }
  return { vendor, overlayProvider: true };
}

/**
 * True when exactly one provider instance is usable, which makes the provider
 * glyph redundant on every row it appears in. One of the two conditions under
 * which clients show the model's vendor glyph; see `resolveModelVendorGlyph`.
 */
export function hasSoleProviderInstance(
  instances: Iterable<{ readonly enabled: boolean; readonly isAvailable: boolean }>,
): boolean {
  let count = 0;
  for (const instance of instances) {
    if (!instance.enabled || !instance.isAvailable) continue;
    if (++count > 1) return false;
  }
  return count === 1;
}
