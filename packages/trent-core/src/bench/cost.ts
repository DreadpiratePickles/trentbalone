/**
 * [C16] What an attempt cost, in the two integer units the report uses.
 *
 * - `ledgerCents`: what Trent's ledger charged (the rows' own `cents`, whole cents rounded up once per run);
 *   for Hermes, which keeps no ledger, the same rounding applied to its list price.
 * - `microCents`: the list price of the same tokens, re-derived from each row's token split with the price
 *   table the meter itself uses (`model-gateway/pricing.ts` `priceCallMicroCents`, 1 cent = 1,000,000). This
 *   is the unit "at most 0.5 cents per successful task" can be judged in: a run of a few thousand flash-lite
 *   tokens is a fraction of a cent, which a whole-cent ledger row always shows as 1.
 *
 * Only model rows count: a tool's own spend (an SMS on the fake Twilio) is the same for every harness and is
 * not what the bench compares.
 */
import type { SpendRow } from "../governance/spend-ledger.js";
import { priceCallMicroCents } from "../model-gateway/pricing.js";
import type { ProviderAlias } from "../model-gateway/providers.js";
import type { TokenCounts } from "./types.js";

export const MICRO_PER_CENT = 1_000_000;

export interface AttemptCost {
  readonly ledgerCents: number;
  readonly microCents: number;
  readonly tokens: TokenCounts;
  readonly unpriced: boolean;
}

export const NO_COST: AttemptCost = { ledgerCents: 0, microCents: 0, tokens: { input: 0, output: 0, cachedInput: 0 }, unpriced: false };

const whole = (value: number | undefined): number => (typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0);

/** The model rows one run wrote to the ledger, priced. */
export function costOfRows(rows: readonly SpendRow[], alias?: ProviderAlias): AttemptCost {
  let ledgerCents = 0;
  let microCents = 0;
  let unpriced = false;
  const tokens = { input: 0, output: 0, cachedInput: 0 };
  for (const row of rows) {
    if (row.surface === "tool" || row.tool !== undefined) continue;
    const cents = whole(row.cents);
    ledgerCents += cents;
    const input = whole(row.inputTokens);
    const output = whole(row.outputTokens);
    const cached = whole(row.cachedInputTokens);
    tokens.input += input;
    tokens.output += output;
    tokens.cachedInput += cached;
    const split = row.inputTokens !== undefined || row.outputTokens !== undefined;
    const priced = split ? priceCallMicroCents({ model: row.model, inputTokens: input, outputTokens: output, cachedInputTokens: cached, ...(alias === undefined ? {} : { alias }) }) : undefined;
    if (priced !== undefined) microCents += priced.microCents;
    else microCents += cents * MICRO_PER_CENT;
    if (row.unpriced === true || (priced === undefined && cents > 0)) unpriced = true;
  }
  return { ledgerCents, microCents, tokens, unpriced };
}

/** A harness that reports tokens and no cost (Hermes): the same table, and the ledger's once-per-run rounding. */
export function costOfTokens(model: string, tokens: TokenCounts, alias?: ProviderAlias): AttemptCost {
  const priced = priceCallMicroCents({ model, inputTokens: tokens.input, outputTokens: tokens.output, cachedInputTokens: tokens.cachedInput, ...(alias === undefined ? {} : { alias }) });
  const microCents = priced?.microCents ?? 0;
  const spent = tokens.input + tokens.output > 0;
  return { ledgerCents: Math.ceil(microCents / MICRO_PER_CENT), microCents, tokens, unpriced: priced === undefined && spent };
}
