import { describe, it, expect, beforeEach } from "vitest";
import { store } from "@/lib/store";
import { db } from "@/lib/db";
import { generateMonthlyInvoice } from "./invoice-generator";

const companyId = "company_trent_demo";
const currentBillingPeriod = () => new Date().toISOString().slice(0, 7);

describe("invoice-generator", () => {
  beforeEach(async () => {
    await store.getCompany(companyId); // triggers seed for FK constraint
    if ("snapshot" in store) {
      const snap = (store as any).snapshot();
      snap.usage = [];
      snap.invoices = [];
    } else {
      // Prisma store: seedDatabase() re-creates seeded usage after TRUNCATE.
      // Explicitly wipe usage and invoices so each test starts clean.
      await db.usageLedgerEntry.deleteMany({ where: { companyId } });
      await db.invoice.deleteMany({ where: { companyId } });
    }
  });

  it("generates an invoice from unbilled usage", async () => {
    const billingPeriod = currentBillingPeriod();
    await store.addUsage({
      companyId,
      category: "llm",
      amountCents: 200,
      description: "LLM call",
      metadata: {}
    });
    await store.addUsage({
      companyId,
      category: "infra",
      amountCents: 50,
      description: "Infra cost",
      metadata: {}
    });
    const invoice = await generateMonthlyInvoice(companyId, billingPeriod);
    expect(invoice.id).toBeDefined();
    expect(invoice.amountCents).toBe(250);
    expect(invoice.status).toBe("unpaid");
    expect(invoice.billingPeriod).toBe(billingPeriod);
    expect(invoice.lineItems.llm).toBeDefined();
    expect(invoice.lineItems.infra).toBeDefined();
  });

  it("is idempotent — returns existing invoice on second call", async () => {
    const billingPeriod = currentBillingPeriod();
    await store.addUsage({
      companyId,
      category: "llm",
      amountCents: 100,
      description: "LLM call",
      metadata: {}
    });
    const first = await generateMonthlyInvoice(companyId, billingPeriod);
    const second = await generateMonthlyInvoice(companyId, billingPeriod);
    expect(first.id).toBe(second.id);
  });

  it("generates a zero-amount invoice when there is no unbilled usage", async () => {
    const invoice = await generateMonthlyInvoice(companyId, "1999-01");
    expect(invoice.amountCents).toBe(0);
    expect(invoice.status).toBe("unpaid");
  });
});
