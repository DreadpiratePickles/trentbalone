import { describe, it, expect, beforeEach } from "vitest";
import { db } from "./db";
import { store } from "./store";
import { nowIso } from "./utils";

const companyId = "company_trent_demo";

describe("Billing DB Store CRUD Operations", () => {
  beforeEach(async () => {
    // Ensure company is seeded to satisfy foreign key constraints
    await store.getCompany(companyId);

    if ("snapshot" in store) {
      const snap = (store as any).snapshot();
      snap.invoices = [];
      snap.ledgerEntries = [];
      snap.payoutHolds = [];
    } else {
      await db.invoice.deleteMany({ where: { companyId } });
      await db.ledgerEntry.deleteMany({ where: { companyId } });
      await db.payoutHold.deleteMany({ where: { companyId } });
    }
  });

  it("can CRUD invoices", async () => {
    const invoiceInput = {
      companyId,
      billingPeriod: "2026-05",
      amountCents: 550,
      status: "unpaid" as const,
      lineItems: { llm: 10, total: 550 }
    };

    const created = await store.createInvoice(invoiceInput);
    expect(created.id).toBeDefined();
    expect(created.amountCents).toBe(550);
    expect(created.status).toBe("unpaid");

    const fetched = await store.getInvoice(created.companyId, "2026-05");
    expect(fetched).toBeDefined();
    expect(fetched?.id).toBe(created.id);

    const updated = await store.updateInvoice(created.id, { status: "paid", txHash: "0xabc" });
    expect(updated?.status).toBe("paid");
    expect(updated?.txHash).toBe("0xabc");

    const list = await store.listInvoices(companyId);
    expect(list.length).toBe(1);
  });

  it("can CRUD ledger entries", async () => {
    const entryInput = {
      companyId,
      type: "debit" as const,
      account: "billing" as const,
      amountCents: 500,
      txHash: "0x123",
      description: "Monthly subscription debit"
    };

    const created = await store.createLedgerEntry(entryInput);
    expect(created.id).toBeDefined();

    const list = await store.listLedgerEntries(companyId);
    expect(list.length).toBe(1);
    expect(list[0].txHash).toBe("0x123");
  });

  it("can CRUD payout holds", async () => {
    const holdInput = {
      companyId,
      creatorWallet: "0xwallet",
      amountCents: 1000,
      status: "held" as const,
      releaseAt: nowIso(),
      reason: "7-day creator hold"
    };

    const created = await store.createPayoutHold(holdInput);
    expect(created.id).toBeDefined();

    const fetched = await store.getPayoutHold(created.id);
    expect(fetched?.amountCents).toBe(1000);

    const updated = await store.updatePayoutHold(created.id, { status: "released" });
    expect(updated?.status).toBe("released");

    const list = await store.listPayoutHolds(companyId);
    expect(list.length).toBe(1);
  });
});
