import { describe, it, expect } from "vitest";
import type { appendAuditLog } from "@/lib/audit-log";
import type { TraceRecord } from "@/lib/trace-store";
import { InMemoryTraceStore } from "@/lib/trace-store";
import { InMemorySkillDraftStore } from "@/lib/skill-foundry";
import { InMemoryIterationLog } from "@/lib/self-improvement/iteration-log";
import type { ApprovalSink } from "@/lib/self-improvement/promotion";
import {
  runAutoresearchSweep,
  type AutoresearchSweepDeps,
} from "@/lib/self-improvement/heartbeat-autoresearch";

const COMPANY = "co_test";
const TASK = "ads";

/** A run trace heavy enough to fire the Foundry's tool-call distillation trigger. */
function distillableTrace(): TraceRecord {
  return {
    id: "t1",
    companyId: COMPANY,
    runId: "r1",
    taskType: TASK,
    agentRole: "growth",
    stepTitle: "Plan paid campaign",
    status: "completed",
    toolCalls: ["search", "draft", "estimate", "segment", "schedule"],
    toolCallCount: 5,
    critiqueVerdict: "pass",
    evalScore: 0.9,
    costCents: 3,
    humanCorrected: false,
    createdAt: new Date().toISOString(),
  };
}

type Harness = {
  deps: AutoresearchSweepDeps;
  approvalCalls: { action: string; previewKind?: string; previewContent?: string }[];
  iterationLog: InMemoryIterationLog;
  draftStore: InMemorySkillDraftStore;
};

function makeHarness(traces: TraceRecord[]): Harness {
  const traceStore = new InMemoryTraceStore();
  const draftStore = new InMemorySkillDraftStore();
  const iterationLog = new InMemoryIterationLog();
  const approvalCalls: Harness["approvalCalls"] = [];

  const approvals: ApprovalSink = {
    async create(input) {
      approvalCalls.push({
        action: input.action,
        previewKind: input.previewKind,
        previewContent: input.previewContent,
      });
      return { id: `appr_${approvalCalls.length}` };
    },
  };

  const auditLog = (async () => {}) as unknown as typeof appendAuditLog;

  return {
    deps: { traceStore, draftStore, iterationLog, approvals, auditLog, skipLLM: true },
    approvalCalls,
    iterationLog,
    draftStore,
  };
}

describe("runAutoresearchSweep — Slice 3 heartbeat wiring", () => {
  it("returns a zeroed report when there are no traces", async () => {
    const h = makeHarness([]);
    const report = await runAutoresearchSweep(COMPANY, h.deps);
    expect(report).toEqual({ draftsDistilled: 0, approvalsRaised: 0, errors: [] });
    expect(h.approvalCalls).toHaveLength(0);
  });

  it("distills a draft, raises a human-review approval, and logs a pending iteration", async () => {
    const trace = distillableTrace();
    const h = makeHarness([trace]);
    await h.deps.traceStore.append(trace);

    const report = await runAutoresearchSweep(COMPANY, h.deps);

    expect(report.errors).toEqual([]);
    expect(report.draftsDistilled).toBeGreaterThanOrEqual(1);
    expect(report.approvalsRaised).toBeGreaterThanOrEqual(1);

    // Approval raised with the human-review action
    expect(h.approvalCalls).toHaveLength(1);
    expect(h.approvalCalls[0].action).toBe("skill.review");
    expect(h.approvalCalls[0].previewKind).toBe("diff");

    // Iteration logged as pending_approval carrying the approval id
    const iters = await h.iterationLog.list(COMPANY);
    expect(iters).toHaveLength(1);
    expect(iters[0].decision).toBe("pending_approval");
    expect(iters[0].approvalId).toBeDefined();

    // No auto-promote: candidate sits in quarantine, live skill untouched
    expect(await h.draftStore.readQuarantine(COMPANY, TASK)).toBeDefined();
    expect(await h.draftStore.readLive(COMPANY, TASK)).toBeUndefined();
  });
});
