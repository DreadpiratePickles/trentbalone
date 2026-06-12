import { describe, expect, it } from "vitest";
import { INTERNAL_ACTIONS, runInternalAction } from "@/lib/internal-actions";
import { store } from "@/lib/store";

async function makeCompany() {
  return store.createCompany({
    name: `Internal Actions ${Date.now()}`,
    brief: {
      vision: "Prove internal actions hit the real store",
      goals: "Compound decisions",
    },
  });
}

describe("internal actions", () => {
  it("exposes a handler for every registered internal action", async () => {
    const company = await makeCompany();
    const actions = [...INTERNAL_ACTIONS].sort();

    expect(actions).toEqual([
      "ads:draft",
      "approvals:create",
      "approvals:request",
      "audit:create",
      "billing:read",
      "crm:update_draft",
      "documents:write",
      "email:draft",
      "goals:read",
      "goals:update",
      "memory:read",
      "prospects:research",
      "reports:create",
      "social:draft",
      "tasks:block",
      "tasks:create",
      "usage:read",
    ]);

    for (const tool of actions) {
      const result = await runInternalAction(tool, `contract smoke for ${tool}`, {
        companyId: company.id,
        actor: "ceo",
        payload: {
          title: `Title ${tool}`,
          content: `Content ${tool}`,
          findings: [`Finding ${tool}`],
          recommendations: [`Recommendation ${tool}`],
          tags: ["contract"],
        },
      });
      expect(result.status, `${tool}: ${result.summary}`).not.toBe("mocked");
      expect(result.status, `${tool}: ${result.summary}`).not.toBe("failed");
    }
  });

  it("creates durable store records for write-like internal actions", async () => {
    const company = await makeCompany();

    await runInternalAction("tasks:create", "Create launch task", { companyId: company.id, actor: "growth" });
    await runInternalAction("reports:create", "Write finance report", { companyId: company.id, actor: "finance" });
    await runInternalAction("documents:write", "Write operating memo", { companyId: company.id, actor: "ceo" });
    const approval = await runInternalAction("approvals:request", "Approve outbound email", { companyId: company.id, actor: "sales" });
    await runInternalAction("audit:create", "Audit risk note", { companyId: company.id, actor: "escalation" });

    const [tasks, reports, documents, approvals, audits] = await Promise.all([
      store.listTasks(company.id),
      store.listReports(company.id),
      store.listDocuments(company.id),
      store.listApprovals(company.id),
      store.listAuditLogs(company.id),
    ]);

    expect(tasks.some((task) => task.prompt.includes("Create launch task"))).toBe(true);
    expect(reports.some((report) => report.findings.includes("Write finance report"))).toBe(true);
    expect(documents.some((doc) => doc.content.includes("Write operating memo"))).toBe(true);
    expect(approvals.some((item) => item.action.includes("Approve outbound email"))).toBe(true);
    expect(audits.some((item) => item.action === "agent.audit")).toBe(true);
    expect(approval.status).toBe("needs_approval");
  });

  it("fails unknown strings loudly instead of pretending they are tools", async () => {
    const company = await makeCompany();
    const result = await runInternalAction("unknown:create", "do something", { companyId: company.id });

    expect(result).toMatchObject({
      adapter: "unknown:create",
      status: "failed",
    });
    expect(result.summary).toContain("not registered");
  });
});
