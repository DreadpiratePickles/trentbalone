/**
 * The wrapper-side price table, keyed by model id.
 *
 * `apps/web/lib/model-gateway.ts:194` (`estimateModelCostCents`, read-only) prices every call by
 * TIER — haiku / sonnet / opus at Anthropic list — regardless of which model actually answered. A
 * `gemini-3.5-flash-lite` call routed through the "sonnet" tier is therefore billed at $3.00 per
 * million input tokens against a $0.30 list price. This table overlays a per-model price when the
 * model id is known; an unknown id keeps the tier price and the meter row says `priced_as_default`.
 *
 * Units: INTEGER micro-cents per million tokens (1 USD = 100 cents = 100,000,000 micro-cents), so
 * a $0.30 / 1M list price is 30,000,000. Output is always integer cents, rounded up.
 *
 * Sources: `google-list-2026-09` = https://ai.google.dev/gemini-api/docs/pricing, paid tier,
 * standard (prompts up to the base context size), read 2026-09-13. `unverified` = the id is not
 * on Google's pricing page; the number is the nearest published Pro-tier price and must be
 * confirmed before it is trusted for billing.
 */

import type { ModelTier } from "./types.js";

export type PriceSource = "google-list-2026-09" | "unverified";

export interface ModelPriceRow {
  readonly inputMicroCentsPerMillion: number;
  readonly outputMicroCentsPerMillion: number;
  readonly source: PriceSource;
  readonly note?: string;
}

const USD_PER_MILLION = 100_000_000; // micro-cents in one dollar
const usd = (dollars: number): number => Math.round(dollars * USD_PER_MILLION);

export const MODEL_PRICE_TABLE: Readonly<Record<string, ModelPriceRow>> = {
  "gemini-3.5-flash-lite": { inputMicroCentsPerMillion: usd(0.3), outputMicroCentsPerMillion: usd(2.5), source: "google-list-2026-09" },
  "gemini-3.5-flash": { inputMicroCentsPerMillion: usd(1.5), outputMicroCentsPerMillion: usd(9.0), source: "google-list-2026-09" },
  "gemini-3.5-pro": {
    inputMicroCentsPerMillion: usd(2.0),
    outputMicroCentsPerMillion: usd(12.0),
    source: "unverified",
    note: "not on Google's pricing page on 2026-09-13; carries the published gemini-3.1-pro (<=200K) price as a stand-in",
  },
};

export interface PriceCallInput {
  readonly model: string;
  readonly modelTier: ModelTier;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface PricedCall {
  /** Integer cents, rounded up. */
  readonly costCents: number;
  /** True when the model id had no row and the tier default priced the call. */
  readonly pricedAsDefault: boolean;
  readonly source: PriceSource | "default";
}

/** The tier pricer the overlay falls back to: the app's `estimateModelCostCents`, or any equivalent. */
export type TierPricer = (input: { modelTier: ModelTier; inputTokens: number; outputTokens: number }) => number;

/** Strips a provider prefix (`google/gemini-3.5-flash`) and a `-latest` suffix; otherwise exact. */
export function normaliseModelId(model: string): string {
  const bare = model.includes("/") ? model.slice(model.lastIndexOf("/") + 1) : model;
  return bare.trim().toLowerCase().replace(/-latest$/, "");
}

export function priceRowFor(model: string): ModelPriceRow | undefined {
  return MODEL_PRICE_TABLE[normaliseModelId(model)];
}

export function priceCall(input: PriceCallInput, tierDefault: TierPricer): PricedCall {
  const row = priceRowFor(input.model);
  if (!row) {
    const costCents = tierDefault({ modelTier: input.modelTier, inputTokens: input.inputTokens, outputTokens: input.outputTokens });
    return { costCents: Math.max(0, Math.ceil(costCents)), pricedAsDefault: true, source: "default" };
  }
  const inputMicro = Math.max(0, input.inputTokens) * row.inputMicroCentsPerMillion;
  const outputMicro = Math.max(0, input.outputTokens) * row.outputMicroCentsPerMillion;
  // micro-cents per million tokens x tokens -> micro-cents x 1e6; divide by 1e6 (tokens per million) and 1e6 (micro-cents per cent).
  const costCents = Math.ceil((inputMicro + outputMicro) / 1_000_000 / 1_000_000);
  return { costCents, pricedAsDefault: false, source: row.source };
}
