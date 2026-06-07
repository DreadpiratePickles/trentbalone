import { describe, expect, it } from "vitest";
import { applyTrenchpadStreamEvent, createTrenchpadLiveState } from "@/lib/trenchpad-live";
import type { TrenchpadStreamEvent } from "@/lib/workbench-event-stream";

describe("trenchpad live reducer", () => {
  it("merges stream events by seq, dedupes older events, and keeps terminal rows ordered", () => {
    const state = createTrenchpadLiveState(baseAggregate());
    const afterSeqTwo = applyTrenchpadStreamEvent(state, streamEvent({ id: "evt_2", seq: 2, type: "command", title: "npm test", command: "npm test" }));
    const afterSeqOne = applyTrenchpadStreamEvent(afterSeqTwo, streamEvent({ id: "evt_1", seq: 1, type: "log", title: "install", content: "installing" }));
    const afterDuplicate = applyTrenchpadStreamEvent(afterSeqOne, streamEvent({ id: "evt_2b", seq: 2, type: "log", title: "duplicate", content: "duplicate" }));

    expect(afterDuplicate.lastSeq).toBe(2);
    expect(afterDuplicate.workStream.map((event) => event.id)).toEqual(["evt_1", "evt_2"]);
    expect(afterDuplicate.terminal.map((row) => row.title)).toEqual(["install", "npm test"]);
  });

  it("builds a file tree and auto-selects the latest written file", () => {
    const state = createTrenchpadLiveState(baseAggregate());
    const withFirst = applyTrenchpadStreamEvent(state, streamEvent({
      id: "evt_1",
      seq: 1,
      type: "file_write",
      title: "app/page.tsx",
      path: "app/page.tsx",
      language: "tsx",
      afterContent: "export default function Page() { return null; }",
    }));
    const withSecond = applyTrenchpadStreamEvent(withFirst, streamEvent({
      id: "evt_2",
      seq: 2,
      type: "file_write",
      title: "app/api/route.ts",
      path: "app/api/route.ts",
      diff: "+return Response.json({ ok: true })",
    }));

    expect(withSecond.selectedFilePath).toBe("app/api/route.ts");
    expect(withSecond.files.map((file) => file.path)).toEqual(["app/api/route.ts", "app/page.tsx"]);
    expect(withSecond.files[0].diff).toContain("+return");
  });

  it("updates plan, preview, cost, approval, and terminal state live", () => {
    const state = createTrenchpadLiveState(baseAggregate());
    const withPlan = applyTrenchpadStreamEvent(state, streamEvent({ id: "evt_1", seq: 1, type: "plan_step", stepId: "step_1", index: 0, title: "Install deps", status: "running" }));
    const withPreview = applyTrenchpadStreamEvent(withPlan, streamEvent({ id: "evt_2", seq: 2, type: "preview", previewUrl: "https://preview.local" }));
    const withCost = applyTrenchpadStreamEvent(withPreview, streamEvent({ id: "evt_3", seq: 3, type: "cost", spentCents: 750, budgetCents: 1000, remainingCents: 250 }));
    const withApproval = applyTrenchpadStreamEvent(withCost, streamEvent({ id: "evt_4", seq: 4, type: "approval_required", stepId: "step_2", title: "Deploy", riskClass: "irreversible" }));
    const complete = applyTrenchpadStreamEvent(withApproval, streamEvent({ id: "evt_5", seq: 5, type: "status", status: "completed", title: "Done" }));

    expect(complete.plan.steps[0]).toMatchObject({ id: "step_1", status: "running" });
    expect(complete.previewUrl).toBe("https://preview.local");
    expect(complete.headerUsage).toMatchObject({ spentCents: 750, remainingCents: 250 });
    expect(complete.approvals[0]).toMatchObject({ stepId: "step_2", riskClass: "irreversible" });
    expect(complete.connection.terminal).toBe(true);
  });
});

function baseAggregate() {
  return {
    companyId: "co_1",
    headerUsage: { spentCents: 0, budgetCents: 1000, remainingCents: 1000 },
    sessionRail: { sessions: [], filters: [], inlineRename: true },
    workStream: [],
    commandCenter: { reuse: "CeoCommandClient", affordances: [] },
    rightPanel: {
      activeSessionId: "ws_1",
      planner: { actions: [], auditRequired: true, steps: [] },
      artifacts: [],
      files: { source: "stream", entries: [] },
      previewUrl: undefined,
    },
    playbooks: { primitive: "playbook", actions: [], storage: "metadata" },
    secrets: { scope: "company_session", providers: [], rendersSecretValues: false, actions: [], auditRequired: true },
  };
}

function streamEvent(patch: Partial<TrenchpadStreamEvent> & { id: string; seq: number; type: TrenchpadStreamEvent["type"] }): TrenchpadStreamEvent {
  return {
    sessionId: "ws_1",
    status: "completed",
    createdAt: `2026-05-29T00:00:${String(patch.seq).padStart(2, "0")}.000Z`,
    title: patch.id,
    content: patch.id,
    ...patch,
  };
}
