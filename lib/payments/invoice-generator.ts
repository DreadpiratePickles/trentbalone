import { store } from "@/lib/store";
import type { Invoice } from "@/lib/types";

/**
 * Generates (or retrieves) a monthly invoice for a company and billing period.
 * Idempotent: returns existing invoice if one already exists for the same
 * companyId + billingPeriod combination.
 *
 * @param companyId     - The company identifier
 * @param billingPeriod - ISO year-month prefix, e.g. "2026-05"
 * @returns The existing or newly created Invoice
 */
export async function generateMonthlyInvoice(
  companyId: string,
  billingPeriod: string
): Promise<Invoice> {
  // 1. Idempotency check
  const existing = await store.getInvoice(companyId, billingPeriod);
  if (existing) {
    return existing;
  }

  // 2. Fetch all usage for the company and filter to unbilled entries in this period
  const allUsage = await store.listUsage(companyId);
  const unbilled = allUsage.filter(
    (entry) =>
      !entry.invoiceId &&
      String(entry.createdAt).startsWith(billingPeriod)
  );

  // 3. Sum amountCents
  const totalCents = unbilled.reduce((sum, entry) => sum + entry.amountCents, 0);

  // 4. Group by category to build lineItems
  const lineItems: Record<string, { count: number; amountCents: number }> = {};
  for (const entry of unbilled) {
    const cat = entry.category;
    if (!lineItems[cat]) {
      lineItems[cat] = { count: 0, amountCents: 0 };
    }
    lineItems[cat].count += 1;
    lineItems[cat].amountCents += entry.amountCents;
  }

  // 5. Create and return the invoice
  const invoice = await store.createInvoice({
    companyId,
    billingPeriod,
    amountCents: totalCents,
    status: "unpaid",
    lineItems,
  });

  return invoice;
}
