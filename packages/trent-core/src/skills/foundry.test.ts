import { describe, it, expect } from "vitest";
import { createSkillFoundry, InMemorySkillDraftStore } from "./foundry.js";
import type { TraceRecord } from "../traces/trace-store.js";

function recoveryTraces(): TraceRecord[] {
  return [
    {
      id: "trace_run1_s1",
      companyId: "co_1",
      runId: "run1",
      taskType: "ship migration",
      agentRole: "engineer",
      stepTitle: "Apply migration",
      status: "failed",
      toolCalls: ["Postgres"],
      toolCallCount: 1,
      critiqueVerdict: "retry",
      improvement: "Snapshot the database first.",
      costCents: 4,
      humanCorrected: false,
      createdAt: "2026-09-01T00:00:00.000Z",
    },
    {
      id: "trace_run1_s2",
      companyId: "co_1",
      runId: "run1",
      taskType: "ship migration",
      agentRole: "engineer",
      stepTitle: "Re-apply migration after snapshot",
      status: "completed",
      toolCalls: ["Postgres"],
      toolCallCount: 1,
      critiqueVerdict: "pass",
      costCents: 5,
      humanCorrected: false,
      createdAt: "2026-09-01T00:05:00.000Z",
    },
  ];
}

describe("skills/foundry wrapper — offline distillation", () => {
  it("writes a draft that round-trips through the injected quarantine store", async () => {
    const draftStore = new InMemorySkillDraftStore();
    const audits: string[] = [];
    const foundry = await createSkillFoundry({
      companyId: "co_1",
      draftStore,
      auditLog: async (_companyId, _actor, action) => {
        audits.push(action);
      },
    });

    const draft = await foundry.distill(recoveryTraces(), "ship migration", {
      id: "skill_fixed",
      now: "2026-09-01T00:10:00.000Z",
    });

    expect(draft).not.toBeNull();
    expect(draft!.id).toBe("skill_fixed");
    expect(draft!.action).toBe("create");
    expect(draft!.status).toBe("quarantine");
    expect(draft!.triggeredBy).toEqual(["error_recovery"]);

    const stored = await draftStore.readQuarantine("co_1", "ship migration");
    expect(stored).toBe(draft!.content);
    expect(audits).toEqual(["skill.distilled"]);
  });

  it("produces agentskills.io frontmatter naming the task type", async () => {
    const draftStore = new InMemorySkillDraftStore();
    const foundry = await createSkillFoundry({ companyId: "co_1", draftStore, auditLog: async () => {} });
    const draft = await foundry.distill(recoveryTraces(), "ship migration", {
      now: "2026-09-01T00:10:00.000Z",
    });
    const content = (await draftStore.readQuarantine("co_1", "ship migration"))!;
    expect(content).toBe(draft!.content);
    expect(content.startsWith("---\nname: ship-migration\n")).toBe(true);
    expect(content).toContain("    taskType: ship migration");
    expect(content).toContain("    companyId: co_1");
    expect(content).toContain("    createdAt: 2026-09-01T00:10:00.000Z");
    expect(content).toContain("## Steps");
    expect(content).toContain("Snapshot the database first.");
  });

  it("re-distilling an existing quarantine draft is an edit, not a create", async () => {
    const draftStore = new InMemorySkillDraftStore();
    const foundry = await createSkillFoundry({ companyId: "co_1", draftStore, auditLog: async () => {} });
    await foundry.distill(recoveryTraces(), "ship migration", { now: "2026-09-01T00:10:00.000Z" });
    const second = await foundry.distill(recoveryTraces(), "ship migration", {
      now: "2026-09-01T00:20:00.000Z",
    });
    expect(second!.action).toBe("edit");
  });

  it("returns null when no distillation trigger fires", async () => {
    const draftStore = new InMemorySkillDraftStore();
    const foundry = await createSkillFoundry({ companyId: "co_1", draftStore, auditLog: async () => {} });
    const [firstTrace] = recoveryTraces();
    const boring = { ...firstTrace, critiqueVerdict: undefined, improvement: undefined };
    expect(await foundry.distill([boring], "ship migration", {})).toBeNull();
    expect(await draftStore.readQuarantine("co_1", "ship migration")).toBeUndefined();
  });
});
