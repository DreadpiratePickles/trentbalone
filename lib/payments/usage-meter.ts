import { store } from "@/lib/store";
import type { UsageLedgerEntry } from "@/lib/types";

/**
 * Pricing rates in cents for metered usage categories.
 * - cycle_run: $5.00 per cycle run
 * - agent_run: $0.50 per agent run
 * - tool_call: $0.05 per tool call
 */
export const PRICING_RATES = {
  cycle_run: 500,
  agent_run: 50,
  tool_call: 5,
} as const;

/**
 * Records a usage event by delegating to store.addUsage.
 * Does not throw if amountCents is 0.
 */
export async function recordUsage(
  companyId: string,
  category: UsageLedgerEntry["category"],
  amountCents: number,
  description: string,
  metadata?: Record<string, string | number | boolean>
): Promise<void> {
  await store.addUsage({
    companyId,
    category,
    amountCents,
    description,
    metadata: metadata ?? {},
  });
}

/**
 * Returns all unbilled usage entries for a company within a billing period.
 *
 * @param companyId - The company to query
 * @param billingPeriod - A string in "YYYY-MM" format (e.g. "2026-05")
 * @returns totalCents (sum of amountCents) and the matching items
 */
export async function getUnbilledUsage(
  companyId: string,
  billingPeriod: string
): Promise<{ totalCents: number; items: UsageLedgerEntry[] }> {
  const all = await store.listUsage(companyId);

  const items = all.filter(
    (entry) =>
      (entry.invoiceId === null || entry.invoiceId === undefined) &&
      entry.createdAt.startsWith(billingPeriod)
  );

  const totalCents = items.reduce((sum, entry) => sum + entry.amountCents, 0);

  return { totalCents, items };
}
