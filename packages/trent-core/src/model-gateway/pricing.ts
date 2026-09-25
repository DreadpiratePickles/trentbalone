/**
 * The wrapper-side price table, keyed by model id and by model-family prefix.
 *
 * `apps/web/lib/model-gateway.ts:194` (`estimateModelCostCents`, read-only) prices every call by
 * TIER — haiku / sonnet / opus at Anthropic list — regardless of which model actually answered. A
 * `gemini-3.5-flash-lite` call routed through the "sonnet" tier is therefore billed at $3.00 per
 * million input tokens against a $0.30 list price, and before this file only three Gemini ids were
 * corrected: OpenAI, Mistral, OpenRouter, DeepSeek, Groq and every Anthropic id billed at the
 * Anthropic tier (audit A.6). This table overlays a per-model price; a model nothing can price
 * keeps the tier estimate and is flagged `unpriced` so the meter never passes a guess off as a bill.
 *
 * Units: INTEGER micro-cents per million tokens (1 USD = 100 cents = 100,000,000 micro-cents), so
 * a $0.30 / 1M list price is 30,000,000. Output is always integer cents, rounded up.
 *
 * Sources. `google-list-2026-09` = https://ai.google.dev/gemini-api/docs/pricing, paid tier,
 * standard prompts, read 2026-09-13. `*-list-2026-05` = that provider's published list price as of
 * the 2026-05 snapshot this wrapper was written against. `local` = the tokens were produced on the
 * operator's own hardware and cost nothing per token. `unverified` = the id is not on any pricing
 * page we hold; the number is the nearest published tier as a stand-in and MUST be confirmed
 * before it is trusted for billing — every unverified row says so in its `note`.
 *
 * [P1-C] Cached prompt tokens. A provider that served part of the prompt from its cache bills those
 * tokens at a fraction of the input rate: `cachedInputRatio` on the row, else
 * `DEFAULT_CACHED_INPUT_RATIO`. The Gemini rows carry Google's own figure from
 * https://ai.google.dev/gemini-api/docs/pricing (read 2026-09-25): "Context caching price" is a tenth
 * of the input price on every listed model (flash-lite $0.30 -> $0.03, 3.5-flash $1.50 -> $0.15,
 * 3.6-flash $0.75 -> $0.075, 2.5-pro $1.25 -> $0.125, 2.5-flash $0.30 -> $0.03). The 0.25 default is
 * deliberately the higher figure: a row nobody checked overstates a cache hit's cost, never hides it.
 */

import { isLocalAlias, type ProviderAlias } from "./providers.js";
import type { ModelOverride, ModelOverrides, ModelProvider, ModelTier } from "./types.js";

export type PriceSource =
  | "google-list-2026-09"
  | "anthropic-list-2026-05"
  | "openai-list-2026-05"
  | "mistral-list-2026-05"
  | "deepseek-list-2026-05"
  | "groq-list-2026-05"
  | "local"
  | "override"
  | "unverified";

export interface ModelPriceRow {
  readonly inputMicroCentsPerMillion: number;
  readonly outputMicroCentsPerMillion: number;
  readonly source: PriceSource;
  readonly contextWindow?: number;
  readonly note?: string;
  /** [P1-C] Cached input tokens bill at this fraction of the input rate. Absent: the default. */
  readonly cachedInputRatio?: number;
}

/** [P1-C] The cached-token ratio for a row that states none, and for the app's tier fallback. */
export const DEFAULT_CACHED_INPUT_RATIO = 0.25;

/** Google's published cached-input fraction (pricing page, see the header). */
const GOOGLE_CACHED = 0.1;

const USD_PER_MILLION = 100_000_000; // micro-cents in one dollar
const usd = (dollars: number): number => Math.round(dollars * USD_PER_MILLION);

const row = (
  input: number,
  output: number,
  source: PriceSource,
  extra: { contextWindow?: number; note?: string; cachedInputRatio?: number } = {},
): ModelPriceRow => ({
  inputMicroCentsPerMillion: usd(input),
  outputMicroCentsPerMillion: usd(output),
  source,
  ...extra,
});

const UNLISTED = (family: string): string =>
  `not on a pricing page we hold on 2026-09-18; carries the published ${family} price as a stand-in`;

/** Exact model ids. Checked before any prefix rule. */
export const MODEL_PRICE_TABLE: Readonly<Record<string, ModelPriceRow>> = {
  "gemini-3.5-flash-lite": row(0.3, 2.5, "google-list-2026-09", { contextWindow: 1_000_000, cachedInputRatio: GOOGLE_CACHED }),
  "gemini-3.5-flash": row(1.5, 9.0, "google-list-2026-09", { contextWindow: 1_000_000, cachedInputRatio: GOOGLE_CACHED }),
  // [P1-C] Listed 2026-09-25 at $0.75 / $3.75 "through Dec 31, 2026" and $1.50 / $7.50 from 2027-01-01.
  "gemini-3.6-flash": row(0.75, 3.75, "google-list-2026-09", {
    cachedInputRatio: GOOGLE_CACHED,
    note: "promotional list price through 2026-12-31; Google lists $1.50 in / $7.50 out from 2027-01-01",
  }),
  "gemini-3.5-pro": row(2.0, 12.0, "unverified", {
    contextWindow: 1_000_000,
    note: "not on Google's pricing page on 2026-09-13; carries the published gemini-3.1-pro (<=200K) price as a stand-in",
  }),
  "gemini-2.5-pro": row(1.25, 10.0, "google-list-2026-09", { contextWindow: 1_048_576, cachedInputRatio: GOOGLE_CACHED }),
  "gemini-2.5-flash": row(0.3, 2.5, "google-list-2026-09", { contextWindow: 1_048_576, cachedInputRatio: GOOGLE_CACHED }),
  "gemini-2.0-flash": row(0.1, 0.4, "google-list-2026-09", { contextWindow: 1_048_576 }),
  "deepseek-chat": row(0.27, 1.1, "deepseek-list-2026-05", { contextWindow: 128_000 }),
  "deepseek-reasoner": row(0.55, 2.19, "deepseek-list-2026-05", { contextWindow: 128_000 }),
  "llama-3.3-70b-versatile": row(0.59, 0.79, "groq-list-2026-05", { contextWindow: 128_000 }),
  "llama-3.1-8b-instant": row(0.05, 0.08, "groq-list-2026-05", { contextWindow: 128_000 }),
  "mixtral-8x7b-32768": row(0.24, 0.24, "groq-list-2026-05", { contextWindow: 32_768 }),
  "gemma2-9b-it": row(0.2, 0.2, "groq-list-2026-05", { contextWindow: 8_192 }),
};

export interface PricePrefixRule {
  /** Matched against the NORMALISED model id (vendor prefix stripped, lower-cased). */
  readonly prefix: string;
  readonly row: ModelPriceRow;
}

/**
 * Family prefixes, longest match wins. A provider ships a dated id per release
 * (`claude-haiku-4-5-20251001`), so an exact-id-only table goes stale the day a model is pinned.
 */
export const MODEL_PRICE_PREFIXES: readonly PricePrefixRule[] = [
  // Anthropic — https://www.anthropic.com/pricing, 2026-05 snapshot.
  { prefix: "claude-haiku-4", row: row(1.0, 5.0, "anthropic-list-2026-05", { contextWindow: 200_000 }) },
  { prefix: "claude-3-5-haiku", row: row(0.8, 4.0, "anthropic-list-2026-05", { contextWindow: 200_000 }) },
  { prefix: "claude-sonnet-4", row: row(3.0, 15.0, "anthropic-list-2026-05", { contextWindow: 200_000 }) },
  { prefix: "claude-3-7-sonnet", row: row(3.0, 15.0, "anthropic-list-2026-05", { contextWindow: 200_000 }) },
  { prefix: "claude-opus-4", row: row(15.0, 75.0, "anthropic-list-2026-05", { contextWindow: 200_000 }) },
  // OpenAI — https://openai.com/api/pricing, 2026-05 snapshot.
  { prefix: "gpt-4.1-nano", row: row(0.1, 0.4, "openai-list-2026-05", { contextWindow: 1_047_576 }) },
  { prefix: "gpt-4.1-mini", row: row(0.4, 1.6, "openai-list-2026-05", { contextWindow: 1_047_576 }) },
  { prefix: "gpt-4.1", row: row(2.0, 8.0, "openai-list-2026-05", { contextWindow: 1_047_576 }) },
  { prefix: "o4-mini", row: row(1.1, 4.4, "openai-list-2026-05", { contextWindow: 200_000 }) },
  { prefix: "o3", row: row(2.0, 8.0, "openai-list-2026-05", { contextWindow: 200_000 }) },
  {
    prefix: "gpt-5",
    row: row(1.25, 10.0, "unverified", {
      contextWindow: 400_000,
      note: UNLISTED("gpt-5 (the 5.x ids this repo configures are not on a page we hold)"),
    }),
  },
  // Mistral — https://mistral.ai/pricing, 2026-05 snapshot.
  { prefix: "mistral-small", row: row(0.1, 0.3, "mistral-list-2026-05", { contextWindow: 128_000 }) },
  { prefix: "mistral-medium", row: row(0.4, 2.0, "mistral-list-2026-05", { contextWindow: 128_000 }) },
  { prefix: "mistral-large", row: row(2.0, 6.0, "mistral-list-2026-05", { contextWindow: 128_000 }) },
  // Groq-hosted open weights.
  { prefix: "llama-3.3-70b", row: row(0.59, 0.79, "groq-list-2026-05", { contextWindow: 128_000 }) },
  { prefix: "llama-3.1-8b", row: row(0.05, 0.08, "groq-list-2026-05", { contextWindow: 128_000 }) },
  { prefix: "gemini-3.5", row: row(1.5, 9.0, "unverified", { note: UNLISTED("gemini-3.5-flash") }) },
];

/** Every token produced on the operator's own machine. */
const LOCAL_ROW: ModelPriceRow = { inputMicroCentsPerMillion: 0, outputMicroCentsPerMillion: 0, source: "local" };

export interface PriceCallInput {
  readonly model: string;
  readonly modelTier: ModelTier;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** [P1-C] The part of `inputTokens` served from the provider's prompt cache. Clamped to `inputTokens`. */
  readonly cachedInputTokens?: number;
  /** The identity the call was routed as. */
  readonly provider?: ModelProvider;
  /** The user-facing alias, when one was used. A local alias prices at zero. */
  readonly alias?: ProviderAlias;
  /** `model_overrides` from config. Beats the table. */
  readonly overrides?: ModelOverrides;
}

export interface PricedCall {
  /** Integer cents, rounded up. */
  readonly costCents: number;
  /** True when the model id had no row and the tier default priced the call. */
  readonly pricedAsDefault: boolean;
  /** True when nothing priced this model: the cost is an estimate, not a bill. */
  readonly unpriced: boolean;
  readonly source: PriceSource | "default";
}

/** The tier pricer the overlay falls back to: the app's `estimateModelCostCents`, or any equivalent. */
export type TierPricer = (input: { modelTier: ModelTier; inputTokens: number; outputTokens: number }) => number;

/** Strips a provider prefix (`anthropic/claude-sonnet-4-6`) and a `-latest` suffix; otherwise exact. */
export function normaliseModelId(model: string): string {
  const bare = model.includes("/") ? model.slice(model.lastIndexOf("/") + 1) : model;
  return bare.trim().toLowerCase().replace(/-latest$/, "");
}

/** Exact id, then the longest matching family prefix, then the local-runtime rule. */
export function priceRowFor(model: string, alias?: ProviderAlias): ModelPriceRow | undefined {
  if (isLocalAlias(alias)) return LOCAL_ROW;
  const id = normaliseModelId(model);
  const exact = MODEL_PRICE_TABLE[id];
  if (exact) return exact;
  let best: PricePrefixRule | undefined;
  for (const rule of MODEL_PRICE_PREFIXES) {
    if (!id.startsWith(rule.prefix)) continue;
    if (best === undefined || rule.prefix.length > best.prefix.length) best = rule;
  }
  return best?.row;
}

function overrideFor(model: string, overrides: ModelOverrides | undefined): ModelOverride | undefined {
  if (!overrides) return undefined;
  const id = normaliseModelId(model);
  for (const [key, value] of Object.entries(overrides)) {
    if (normaliseModelId(key) === id) return value;
  }
  return undefined;
}

/** The context window for a model: an override first, then the table. Undefined when unknown. */
export function contextWindowFor(
  model: string,
  alias?: ProviderAlias,
  overrides?: ModelOverrides,
): number | undefined {
  const override = overrideFor(model, overrides);
  if (typeof override?.context_window === "number" && override.context_window > 0) return override.context_window;
  return priceRowFor(model, alias)?.contextWindow;
}

/** [P1-C] The cached share of the prompt, whole and never more than the prompt. */
function cachedShare(inputTokens: number, cachedInputTokens: number | undefined): { uncached: number; cached: number } {
  const input = Math.max(0, inputTokens);
  const cached = Math.min(input, Math.max(0, Math.trunc(cachedInputTokens ?? 0)));
  return { uncached: input - cached, cached };
}

function centsFrom(row: ModelPriceRow, inputTokens: number, outputTokens: number, cachedInputTokens?: number): number {
  const { uncached, cached } = cachedShare(inputTokens, cachedInputTokens);
  const cachedRate = Math.round(row.inputMicroCentsPerMillion * (row.cachedInputRatio ?? DEFAULT_CACHED_INPUT_RATIO));
  const inputMicro = uncached * row.inputMicroCentsPerMillion + cached * cachedRate;
  const outputMicro = Math.max(0, outputTokens) * row.outputMicroCentsPerMillion;
  // micro-cents per million x tokens -> divide by 1e6 (tokens per million) and 1e6 (micro-cents per cent).
  return Math.ceil((inputMicro + outputMicro) / 1_000_000 / 1_000_000);
}

export function priceCall(input: PriceCallInput, tierDefault: TierPricer): PricedCall {
  const override = overrideFor(input.model, input.overrides);
  const hasOverridePrice =
    typeof override?.input_cents_per_million === "number" || typeof override?.output_cents_per_million === "number";
  if (override && hasOverridePrice) {
    // An override prices the tokens; the model's cached ratio still applies (it is a property of the
    // provider's cache, not of the rate someone negotiated).
    const ratio = priceRowFor(input.model, input.alias)?.cachedInputRatio;
    const overrideRow: ModelPriceRow = {
      inputMicroCentsPerMillion: Math.round((override.input_cents_per_million ?? 0) * 1_000_000),
      outputMicroCentsPerMillion: Math.round((override.output_cents_per_million ?? 0) * 1_000_000),
      source: "override",
      ...(ratio === undefined ? {} : { cachedInputRatio: ratio }),
    };
    return {
      costCents: centsFrom(overrideRow, input.inputTokens, input.outputTokens, input.cachedInputTokens),
      pricedAsDefault: false,
      unpriced: false,
      source: "override",
    };
  }

  const priceRow = priceRowFor(input.model, input.alias);
  if (!priceRow) {
    // The tier pricer takes whole tokens, so the cached share is converted to its full-rate
    // equivalent at the default ratio and rounded UP: never cheaper than the bill.
    const { uncached, cached } = cachedShare(input.inputTokens, input.cachedInputTokens);
    const costCents = tierDefault({
      modelTier: input.modelTier,
      inputTokens: uncached + Math.ceil(cached * DEFAULT_CACHED_INPUT_RATIO),
      outputTokens: input.outputTokens,
    });
    return { costCents: Math.max(0, Math.ceil(costCents)), pricedAsDefault: true, unpriced: true, source: "default" };
  }
  return {
    costCents: centsFrom(priceRow, input.inputTokens, input.outputTokens, input.cachedInputTokens),
    pricedAsDefault: false,
    unpriced: false,
    source: priceRow.source,
  };
}

/** The env bridge for `model_overrides`, mirroring `applyPrivacyEnv` for the privacy block. */
export const MODEL_OVERRIDES_ENV = "TRENT_MODEL_OVERRIDES";

/** Writes the overrides where a gateway built with no arguments can read them. NAMES are returned. */
export function applyModelOverridesEnv(
  overrides: ModelOverrides | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (!overrides || Object.keys(overrides).length === 0) return [];
  env[MODEL_OVERRIDES_ENV] = JSON.stringify(overrides);
  return [MODEL_OVERRIDES_ENV];
}

/** Reads the bridge. A malformed payload is ignored: a bad price must not end a run mid-turn. */
export function modelOverridesFromEnv(env: NodeJS.ProcessEnv = process.env): ModelOverrides {
  const raw = env[MODEL_OVERRIDES_ENV];
  if (raw === undefined || raw.trim() === "") return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as ModelOverrides;
  } catch {
    return {};
  }
}
