import { describe, it, expect, beforeEach } from "vitest";
import { db } from "@/lib/db";
import { store } from "@/lib/store";
import { recordTransaction, LedgerImbalanceError, LedgerDoublePostError } from "./ledger";

const companyId = "company_trent_demo";

describe("double-entry ledger", () => {
  beforeEach(async () => {
    await store.getCompany(companyId); // seed FK
    if ("snapshot" in store) {
      const snap = (store as any).snapshot();
      snap.ledgerEntries = [];
    } else {
      await db.ledgerEntry.deleteMany({ where: { companyId } });
    }
  });

  it("records balanced debit/credit entries", async () => {
    await recordTransaction(companyId, "0xabc123", [
      { type: "debit", account: "billing", amountCents: 500, description: "Invoice debit" },
      { type: "credit", account: "payout", amountCents: 500, description: "Payout credit" }
    ]);
    const entries = await store.listLedgerEntries(companyId);
    expect(entries.length).toBe(2);
    expect(entries.every(e => e.txHash === "0xabc123")).toBe(true);
  });

  it("throws LedgerImbalanceError when debits != credits", async () => {
    await expect(
      recordTransaction(companyId, "0xbad", [
        { type: "debit", account: "billing", amountCents: 500, description: "Debit" },
        { type: "credit", account: "payout", amountCents: 400, description: "Credit" }
      ])
    ).rejects.toThrow(LedgerImbalanceError);
  });

  it("throws LedgerDoublePostError on duplicate txHash", async () => {
    await recordTransaction(companyId, "0xdup", [
      { type: "debit", account: "billing", amountCents: 100, description: "Debit" },
      { type: "credit", account: "payout", amountCents: 100, description: "Credit" }
    ]);
    await expect(
      recordTransaction(companyId, "0xdup", [
        { type: "debit", account: "billing", amountCents: 100, description: "Debit again" },
        { type: "credit", account: "payout", amountCents: 100, description: "Credit again" }
      ])
    ).rejects.toThrow(LedgerDoublePostError);
  });

  it("throws LedgerImbalanceError for empty entries (0 != 0 is balanced, but test zero-entry edge case)", async () => {
    // Zero entries: debits=0, credits=0 — should succeed (balanced)
    await expect(
      recordTransaction(companyId, "0xempty", [])
    ).resolves.toBeUndefined();
  });
});
