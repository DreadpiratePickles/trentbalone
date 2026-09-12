import { describe, it, expect } from "vitest";
import type { appendAuditLog } from "@/lib/audit-log";
import type { TraceRecord } from "@/lib/trace-store";
import { InMemorySkillDraftStore } from "@/lib/skill-foundry";
import { RecordedActualsProvider } from "@/lib/self-improvement/actuals-provider";
import { InMemoryIterationLog } from "@/lib/self-improvement/iteration-log";
import type { ApprovalSink } from "@/lib/self-improvement/promotion";
import type { SkillEvalsJson } from "@/lib/self-improvement/frozen-suite";
import { runSkillIteration, type IterationDeps } from "@/lib/self-improvement/autoresearch-iteration";

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

const SKILL: SkillEvalsJson = {
  skill_name: "ads",
  evals: [{ id: 1, prompt: "Plan a paid ads budget for a B2B SaaS", assertions: ["mentions budget"] }],
};

/** Deterministic mechanical grader so the frozen suite yields a real pass/fail. */
const gradersFor = () => [{ type: "contains" as const, weight: 1, values: ["budget"] }];

type Harness = {
  deps: IterationDeps;
  approvalCalls: { action: string; previewKind?: string; previewContent?: string }[];
  auditActions: () => string[];
  iterationLog: InMemoryIterationLog;
  draftStore: InMemorySkillDraftStore;
};

function makeHarness(): Harness {
  const draftStore = new InMemorySkillDraftStore();
  const iterationLog = new InMemoryIterationLog();
  const approvalCalls: Harness["approvalCalls"] = [];
  const auditCalls: unknown[][] = [];

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

  const auditLog = (async (...args: unknown[]) => {
    auditCalls.push(args);
  }) as unknown as typeof appendAuditLog;

  return {
    deps: { draftStore, approvals, iterationLog, auditLog },
    approvalCalls,
    auditActions: () => auditCalls.map((a) => String(a[2])),
    iterationLog,
    draftStore,
  };
}

describe("runSkillIteration — autoresearch keep/revert with approval gate", () => {
  it("keeps a non-regressing candidate by raising a pending approval (no live write)", async () => {
    const h = makeHarness();
    const actuals = new RecordedActualsProvider({
      "ads:1": { text: "Recommend a $5k monthly budget split across LinkedIn and Google." },
    });

    const outcome = await runSkillIteration({
      companyId: COMPANY,
      taskType: TASK,
      traces: [distillableTrace()],
      skill: SKILL,
      actuals,
      baseline: { score: 0.9, failureClusters: {} },
      deps: h.deps,
      gradersFor,
      skipLLM: true,
    });

    // Decision: keep → pending approval
    expect(outcome.decision).toBe("pending_approval");
    expect(outcome.score).toBe(1);
    expect(outcome.delta).toBeGreaterThanOrEqual(0);
    expect(outcome.approvalId).toBeDefined();

    // An approval was raised carrying a diff preview
    expect(h.approvalCalls).toHaveLength(1);
    expect(h.approvalCalls[0].action).toBe("skill.promotion");
    expect(h.approvalCalls[0].previewKind).toBe("diff");
    expect(h.approvalCalls[0].previewContent).toContain("+ ");

    // Audit trail: distillation + promotion request
    expect(h.auditActions()).toContain("skill.distilled");
    expect(h.auditActions()).toContain("skill.promotion_requested");

    // Iteration logged as pending_approval
    const iters = await h.iterationLog.list(COMPANY);
    expect(iters).toHaveLength(1);
    expect(iters[0].decision).toBe("pending_approval");
    expect(iters[0].approvalId).toBe(outcome.approvalId);

    // No live-tenant side effect: candidate is in quarantine, live skill untouched
    expect(await h.draftStore.readQuarantine(COMPANY, TASK)).toBeDefined();
    expect(await h.draftStore.readLive(COMPANY, TASK)).toBeUndefined();
  });

  it("reverts a regressing candidate: discards it, audits, raises no approval", async () => {
    const h = makeHarness();
    const actuals = new RecordedActualsProvider({
      "ads:1": { text: "Here is some ad copy with no spend guidance." },
    });

    const outcome = await runSkillIteration({
      companyId: COMPANY,
      taskType: TASK,
      traces: [distillableTrace()],
      skill: SKILL,
      actuals,
      baseline: { score: 0.9, failureClusters: {} },
      deps: h.deps,
      gradersFor,
      skipLLM: true,
    });

    expect(outcome.decision).toBe("rejected");
    expect(outcome.blockedBy).toBe("regression");
    expect(outcome.score).toBe(0);

    // No approval raised for a regression
    expect(h.approvalCalls).toHaveLength(0);

    // Audited as rejected
    expect(h.auditActions()).toContain("skill.rejected");

    // Iteration logged as rejected
    const iters = await h.iterationLog.list(COMPANY);
    expect(iters).toHaveLength(1);
    expect(iters[0].decision).toBe("rejected");
    expect(iters[0].blockedBy).toBe("regression");

    // Live skill still untouched
    expect(await h.draftStore.readLive(COMPANY, TASK)).toBeUndefined();
  });
});
