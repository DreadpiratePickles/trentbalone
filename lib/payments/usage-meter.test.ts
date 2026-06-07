import { describe, it, expect, beforeEach } from "vitest";
import { store } from "@/lib/store";
import { db } from "@/lib/db";
import { recordUsage, getUnbilledUsage, PRICING_RATES } from "./usage-meter";

const companyId = "company_trent_demo";
const currentBillingPeriod = () => new Date().toISOString().slice(0, 7);

describe("usage-meter", () => {
  beforeEach(async () => {
    // Ensure company_trent_demo is seeded (triggers seedDatabase() for Prisma store).
    // This satisfies FK constraints on UsageLedgerEntry.
    await store.getCompany(companyId);

    // Reset state between tests (mem-store only; Prisma uses global TRUNCATE + re-seed)
    if ("snapshot" in store) {
      const snap = (store as any).snapshot();
      snap.usage = [];
      snap.invoices = [];
    } else {
      await db.usageLedgerEntry.deleteMany({ where: { companyId } });
      await db.invoice.deleteMany({ where: { companyId } });
    }
  });

  it("exports PRICING_RATES constants", () => {
    expect(PRICING_RATES.cycle_run).toBe(500);
    expect(PRICING_RATES.agent_run).toBe(50);
    expect(PRICING_RATES.tool_call).toBe(5);
  });

  it("recordUsage delegates to store.addUsage", async () => {
    await recordUsage(companyId, "llm", 100, "test usage");
    const usage = await store.listUsage(companyId);
    expect(usage.length).toBeGreaterThan(0);
    expect(usage.some(u => u.description === "test usage" && u.amountCents === 100)).toBe(true);
  });

  it("getUnbilledUsage returns entries without invoiceId for the billing period", async () => {
    const billingPeriod = currentBillingPeriod();
    await store.addUsage({
      companyId,
      category: "llm",
      amountCents: 200,
      description: "Current period LLM usage",
      metadata: {}
    });
    const { totalCents, items } = await getUnbilledUsage(companyId, billingPeriod);
    expect(totalCents).toBeGreaterThanOrEqual(200);
    expect(items.length).toBeGreaterThan(0);
  });

  it("getUnbilledUsage excludes billed entries (those with invoiceId set)", async () => {
    // Add billed entry manually via store
    const entry = await store.addUsage({
      companyId,
      category: "llm",
      amountCents: 999,
      description: "Already billed",
      metadata: {}
    });
    // Simulate marking it as billed by directly setting invoiceId on the state
    if ("snapshot" in store) {
      const snap = (store as any).snapshot();
      const found = snap.usage.find((u: any) => u.id === entry.id);
      if (found) found.invoiceId = "invoice_xxx";
    } else {
      const invoice = await db.invoice.create({
        data: {
          companyId,
          billingPeriod: currentBillingPeriod(),
          amountCents: 999,
          status: "unpaid",
          lineItems: { llm: { count: 1, amountCents: 999 } }
        }
      });
      await db.usageLedgerEntry.update({
        where: { id: entry.id },
        data: { invoiceId: invoice.id }
      });
    }
    const { items } = await getUnbilledUsage(companyId, currentBillingPeriod());
    expect(items.every((u: any) => !u.invoiceId)).toBe(true);
  });
});
