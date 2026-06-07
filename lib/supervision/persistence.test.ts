import { describe, expect, it } from "vitest";
import { store } from "@/lib/store";
import {
  listPersistedSupervisionLedger,
  listQueuedSupervisionActions,
  persistSupervisionActionLedgerEntry,
  persistSupervisionQueuedAction,
} from "./persistence";

describe("persistent supervision queue and ledger", () => {
  it("persists queued supervision actions in the durable job table", async () => {
    const company = await store.createCompany({
      name: `Supervision Queue ${Date.now()}`,
      brief: { vision: "Persist approval-gated actions" },
    });

    const persisted = await persistSupervisionQueuedAction({
      companyId: company.id,
      action: "github.pr.merge",
      riskClass: "costly",
      requestedAt: "2026-05-30T18:00:00.000Z",
      defaultCoolingOffMinutes: 10,
      approvalId: "approval_1",
      payload: { branch: "feature/app-builder" },
    });

    expect(persisted.jobRun.type).toBe("supervision_action");
    expect(persisted.jobRun.metadata).toMatchObject({
      kind: "action_queue",
      approvalId: "approval_1",
      payload: { branch: "feature/app-builder" },
    });

    const queued = await listQueuedSupervisionActions(company.id);
    expect(queued).toEqual([
      expect.objectContaining({
        id: persisted.action.id,
        action: "github.pr.merge",
        status: "cooling_off",
      }),
    ]);
  });

  it("persists action ledger entries and writes an audit-chain record", async () => {
    const company = await store.createCompany({
      name: `Supervision Ledger ${Date.now()}`,
      brief: { vision: "Persist executed supervision actions" },
    });

    const persisted = await persistSupervisionActionLedgerEntry({
      companyId: company.id,
      action: "email.draft.update",
      objectId: "draft_1",
      createdAt: "2026-05-30T18:05:00.000Z",
      riskClass: "reversible",
      rollback: { kind: "restore", targetId: "draft_1", previousValue: { subject: "Old" } },
      result: { draftId: "draft_1", status: "updated" },
    });

    const ledger = await listPersistedSupervisionLedger(company.id);
    const audits = await store.listAuditLogs(company.id);

    expect(persisted.jobRun.status).toBe("completed");
    expect(ledger).toEqual([
      expect.objectContaining({
        id: persisted.entry.id,
        action: "email.draft.update",
        objectId: "draft_1",
      }),
    ]);
    expect(audits.some((audit) => audit.action === "supervision.action.executed")).toBe(true);
  });
});
