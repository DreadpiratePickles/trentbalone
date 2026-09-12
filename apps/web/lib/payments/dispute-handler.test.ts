import { describe, it, expect, beforeEach } from "vitest";
import { store } from "@/lib/store";
import { escalateDispute } from "./dispute-handler";

describe("dispute-handler", () => {
  beforeEach(async () => {
    await store.getCompany("company_trent_demo"); // seed FK
    if ("snapshot" in store) {
      const snap = (store as any).snapshot();
      snap.approvals = [];
    }
  });

  it("creates a pending approval in the queue", async () => {
    const approval = await escalateDispute(
      "company_trent_demo",
      "0xabc123",
      500,
      "0xcounterparty"
    );
    expect(approval.id).toBeDefined();
    expect(approval.status).toBe("pending");
    expect(approval.action).toBe("resolve_dispute");
    expect(approval.companyId).toBe("company_trent_demo");
  });

  it("sets reason to 'Dispute for transaction: <txHash>'", async () => {
    const approval = await escalateDispute(
      "company_trent_demo",
      "0xdeadbeef",
      1000,
      "0xwallet"
    );
    expect(approval.reason).toBe("Dispute for transaction: 0xdeadbeef");
  });

  it("previewKind is 'generic' and previewContent contains riskClass and resolutionOptions", async () => {
    const approval = await escalateDispute(
      "company_trent_demo",
      "0xtest",
      250,
      "0xwallet2"
    );
    expect(approval.previewKind).toBe("generic");
    const content = JSON.parse(approval.previewContent!);
    expect(content.riskClass).toBe("irreversible");
    expect(content.txHash).toBe("0xtest");
    expect(content.amountCents).toBe(250);
    expect(content.counterpartyWallet).toBe("0xwallet2");
    expect(content.resolutionOptions).toContain("mark_as_verified");
    expect(content.resolutionOptions).toContain("initiate_manual_off_chain_refund");
    expect(content.resolutionOptions).toContain("cancel_in_internal_logs");
  });

  it("approval appears in store.listApprovals", async () => {
    await escalateDispute("company_trent_demo", "0xstorecheck", 100, "0xwallet3");
    const approvals = await store.listApprovals("company_trent_demo");
    const found = approvals.find(a => a.reason.includes("0xstorecheck"));
    expect(found).toBeDefined();
    expect(found?.action).toBe("resolve_dispute");
  });
});
