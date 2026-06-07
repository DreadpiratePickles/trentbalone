import { describe, expect, it } from "vitest";
import { createRollbackPlanForWindow, recordActionLedgerEntry } from "./action-ledger";

describe("action ledger rollback planning", () => {
  it("builds undo plans for reversible actions inside the requested time window only", () => {
    const now = "2026-05-29T20:30:00.000Z";
    const entries = [
      recordActionLedgerEntry({
        companyId: "co_1",
        action: "email.draft.update",
        objectId: "draft_1",
        createdAt: "2026-05-29T20:12:00.000Z",
        riskClass: "reversible",
        rollback: { kind: "restore", targetId: "draft_1", previousValue: { subject: "Old" } },
      }),
      recordActionLedgerEntry({
        companyId: "co_1",
        action: "database.customer.delete",
        objectId: "customer_1",
        createdAt: "2026-05-29T20:15:00.000Z",
        riskClass: "irreversible",
      }),
      recordActionLedgerEntry({
        companyId: "co_1",
        action: "social.post.edit",
        objectId: "post_1",
        createdAt: "2026-05-29T19:10:00.000Z",
        riskClass: "reversible",
        rollback: { kind: "restore", targetId: "post_1", previousValue: { body: "Old" } },
      }),
    ];

    const plan = createRollbackPlanForWindow({ entries, now, windowMinutes: 30 });

    expect(plan.windowMinutes).toBe(30);
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]).toMatchObject({ actionId: entries[0].id, rollbackKind: "restore" });
    expect(plan.excluded).toEqual([
      expect.objectContaining({ actionId: entries[1].id, reason: "irreversible" }),
    ]);
  });
});
