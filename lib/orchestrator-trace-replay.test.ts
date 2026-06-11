import { describe, expect, it } from "vitest";
import { buildOrchestratorTraceReplay } from "@/lib/orchestrator-trace-replay";
import type { OrchestratorEvent, OrchestratorRun, OrchestratorStep } from "@/lib/types";

describe("buildOrchestratorTraceReplay", () => {
  it("normalizes persisted run, step, and event state into a replayable timeline", () => {
    const run = makeRun({ status: "completed", summary: "CEO: launch plan ready." });
    const steps: OrchestratorStep[] = [
      makeStep({ id: "step_1", seq: 1, agentRole: "analyst", title: "Research market", output: "Trend brief ready", costCents: 12 }),
      makeStep({ id: "step_2", seq: 2, agentRole: "growth", title: "Draft campaign", output: "Campaign brief ready", costCents: 18 }),
    ];
    const events: OrchestratorEvent[] = [
      makeEvent({ seq: 1, kind: "snapshot", payload: { run: { status: "running" } } }),
      makeEvent({
        seq: 2,
        kind: "plan_end",
        payload: {
          run: {
            plan: {
              steps: [
                { id: "step_1", spec: { acceptance: ["Trend brief includes source links"] } },
                { id: "step_2", spec: { acceptance: ["Campaign brief names target channel"] } },
              ],
            },
          },
        },
      }),
      makeEvent({ seq: 3, kind: "step_start", stepId: "step_1", payload: { step: steps[0] } }),
      makeEvent({ seq: 4, kind: "step_output", stepId: "step_1", payload: { step: steps[0] } }),
      makeEvent({ seq: 5, kind: "run_done", payload: { run: { summary: run.summary } } }),
    ];

    const replay = buildOrchestratorTraceReplay({ run, steps, events });

    expect(replay.runId).toBe("orc_1");
    expect(replay.status).toBe("completed");
    expect(replay.timeline.map((item) => `${item.seq}:${item.kind}`)).toEqual([
      "1:snapshot",
      "2:plan_end",
      "3:step_start",
      "4:step_output",
      "5:run_done",
    ]);
    expect(replay.seatReports).toEqual([
      expect.objectContaining({
        seat: "analyst",
        title: "Research market",
        output: "Trend brief ready",
        acceptanceCriteria: ["Trend brief includes source links"],
      }),
      expect.objectContaining({
        seat: "growth",
        title: "Draft campaign",
        output: "Campaign brief ready",
        acceptanceCriteria: ["Campaign brief names target channel"],
      }),
    ]);
    expect(replay.costCents).toBe(30);
    expect(replay.reconnectCursor).toBe("5");
    expect(replay.ceoSummary).toBe("CEO: launch plan ready.");
  });

  it("extracts tools, artifacts, approvals, and errors for trace replay evidence", () => {
    const run = makeRun({ status: "failed", summary: "Blocked by approval." });
    const steps: OrchestratorStep[] = [
      makeStep({
        id: "step_1",
        seq: 1,
        agentRole: "growth",
        title: "Draft campaign",
        toolCalls: [{ adapter: "steel", action: "search", status: "completed", summary: "Market scan" }],
      }),
    ];
    const events: OrchestratorEvent[] = [
      makeEvent({ seq: 1, kind: "step_output", stepId: "step_1", payload: { artifactId: "artifact_1", detail: "Draft saved" } }),
      makeEvent({ seq: 2, kind: "step_awaiting_approval", stepId: "step_1", payload: { approvalId: "approval_1", reason: "Publish requires human approval" } }),
      makeEvent({ seq: 3, kind: "run_failed", payload: { error: "Provider unavailable" } }),
    ];

    const replay = buildOrchestratorTraceReplay({ run, steps, events });

    expect(replay.toolLedger).toEqual([{ name: "steel.search", count: 1 }]);
    expect(replay.artifactRefs).toEqual(["artifact_1"]);
    expect(replay.approvalRefs).toEqual(["approval_1"]);
    expect(replay.errors.map((item) => item.detail)).toContain("Provider unavailable");
    expect(replay.blockers.map((item) => item.detail)).toContain("Publish requires human approval");
  });

  it("summarizes handoff quality signals from persisted handoff events", () => {
    const run = makeRun({ status: "completed", summary: "Done." });
    const events: OrchestratorEvent[] = [
      makeEvent({
        seq: 1,
        kind: "handoff_event",
        payload: {
          from: "analyst",
          to: "growth",
          severity: "amber",
          summary: "Segment research complete.",
          nextActions: ["Draft the campaign."],
          risks: ["Small sample."],
          whatIDidNotDo: ["No prospect outreach."],
          payloadRef: "artifact_1",
          contractVersion: "handoff.v1",
        },
      }),
      makeEvent({
        seq: 2,
        kind: "handoff_event",
        payload: {
          from: "growth",
          to: "ceo",
          severity: "red",
          summary: "Blocked on approval.",
          nextActions: [],
          risks: ["Launch is blocked."],
          whatIDidNotDo: [],
          payloadRef: "",
          contractVersion: "handoff.v1",
        },
      }),
    ];

    const replay = buildOrchestratorTraceReplay({ run, steps: [], events });

    expect(replay.handoffSummary).toEqual({
      total: 2,
      nextActionCount: 1,
      riskCount: 2,
      notDoneCount: 1,
      missingPayloadRefCount: 1,
      amberOrRedCount: 2,
    });
  });
});

function makeRun(overrides: Partial<OrchestratorRun> = {}): OrchestratorRun {
  return {
    id: "orc_1",
    companyId: "co_1",
    objective: "Launch campaign",
    trigger: "manual",
    status: "running",
    modelPolicy: {},
    budgetCents: 500,
    costCents: 0,
    replanCount: 0,
    startedAt: "2026-06-04T00:00:00.000Z",
    updatedAt: "2026-06-04T00:00:00.000Z",
    ...overrides,
  };
}

function makeStep(overrides: Partial<OrchestratorStep>): OrchestratorStep {
  return {
    id: "step_1",
    runId: "orc_1",
    companyId: "co_1",
    seq: 1,
    title: "Step",
    rationale: "Needed",
    agentRole: "ceo",
    dependsOn: [],
    expectedOutput: "Report",
    riskLevel: "low",
    needsApproval: false,
    status: "completed",
    ...overrides,
  };
}

function makeEvent(overrides: Partial<OrchestratorEvent>): OrchestratorEvent {
  return {
    id: `evt_${overrides.seq ?? 1}`,
    runId: "orc_1",
    companyId: "co_1",
    seq: overrides.seq ?? 1,
    kind: "snapshot",
    payload: {},
    createdAt: "2026-06-04T00:00:00.000Z",
    ...overrides,
  };
}
