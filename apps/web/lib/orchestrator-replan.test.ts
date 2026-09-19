import { beforeEach, describe, expect, it, vi } from "vitest";
import { store } from "@/lib/store";
import { makeId } from "@/lib/utils";
import type { OrchestrationPlan, OrchestrationStep, StepRecord } from "@/lib/orchestrator-runtime";
import { buildStepHandoff } from "@/lib/orchestrator-runtime";
import {
  MAX_REPLANS,
  applyRevisedPlanTail,
  buildReplanPlanningPrompts,
  canApplyReplan,
  buildEscalationReplanPrompt,
  reviseOrchestrationPlanTail,
} from "@/lib/orchestrator-replan";
import { deleteCachedOrchestrationRun } from "@/lib/orchestrator-cache";
import { hydrateOrchestrationRun } from "@/lib/orchestrator-run-persist";
import { handleStepCritique, type OrchestrationRun } from "@/lib/orchestrator";

const mockAi = vi.hoisted(() => ({
  callJson: vi.fn(),
  MAX_TOKENS: { PLANNING: 1200 },
  MODELS: { STRONG: "strong-model" },
}));

vi.mock("@/lib/ai-client", () => mockAi);

const basePlan = vi.hoisted((): OrchestrationPlan => ({
  objective: "Ship a revised checklist",
  reasoning: "test plan",
  steps: [
    {
      id: "s1",
      title: "Scope objective",
      rationale: "Define done",
      agentRole: "ceo",
      dependsOn: [],
      expectedOutput: "Success definition",
      riskLevel: "low",
      needsApproval: false,
    },
    {
      id: "s2",
      title: "Execute primary workstream",
      rationale: "Deliverable",
      agentRole: "engineer",
      dependsOn: ["s1"],
      expectedOutput: "First-pass deliverable",
      riskLevel: "medium",
      needsApproval: false,
    },
    {
      id: "s3",
      title: "Consolidate",
      rationale: "Wrap up",
      agentRole: "ceo",
      dependsOn: ["s2"],
      expectedOutput: "Summary",
      riskLevel: "low",
      needsApproval: false,
    },
  ],
  successCriteria: ["Deliverable produced"],
  blockers: [],
}));

function completedStep(step: OrchestrationStep, output: string): StepRecord {
  return { ...step, status: "completed", output, completedAt: new Date().toISOString() };
}

function pendingStep(step: OrchestrationStep): StepRecord {
  return { ...step, status: "pending" };
}

beforeEach(() => {
  mockAi.callJson.mockReset();
  mockAi.callJson.mockRejectedValue(new Error("not configured"));
});

describe("MAX_REPLANS budget", () => {
  it("mirrors delegation depth cap", () => {
    expect(MAX_REPLANS).toBe(2);
  });

  it("allows replan while under budget and blocks at cap", () => {
    expect(canApplyReplan(0)).toBe(true);
    expect(canApplyReplan(1)).toBe(true);
    expect(canApplyReplan(2)).toBe(false);
    expect(canApplyReplan(99)).toBe(false);
  });
});

describe("applyRevisedPlanTail", () => {
  it("keeps completed steps unchanged and replaces only the unfinished tail", () => {
    const steps: StepRecord[] = [
      completedStep(basePlan.steps[0], "scoped"),
      { ...pendingStep(basePlan.steps[1]), status: "running", output: "wrong shape" },
      pendingStep(basePlan.steps[2]),
    ];

    const revisedTail: OrchestrationStep[] = [
      {
        id: "s4",
        title: "Recovery: rebuild deliverable with corrected approach",
        rationale: "Original plan assumed wrong toolchain",
        agentRole: "engineer",
        dependsOn: ["s1"],
        expectedOutput: "Corrected deliverable",
        riskLevel: "medium",
        needsApproval: false,
      },
      {
        id: "s5",
        title: "Consolidate recovery output",
        rationale: "Wrap up",
        agentRole: "ceo",
        dependsOn: ["s4"],
        expectedOutput: "Summary",
        riskLevel: "low",
        needsApproval: false,
      },
    ];

    const next = applyRevisedPlanTail({ steps, failedStepId: "s2", revisedTail });

    expect(next.filter((step) => step.id === "s1")).toEqual([
      expect.objectContaining({ id: "s1", status: "completed", output: "scoped" }),
    ]);
    expect(next.find((step) => step.id === "s2")).toMatchObject({ status: "failed" });
    expect(next.find((step) => step.id === "s3")).toBeUndefined();
    expect(next.find((step) => step.id === "s4")).toMatchObject({ status: "pending" });
    expect(next.find((step) => step.id === "s5")).toMatchObject({ status: "pending", dependsOn: ["s4"] });
  });

  it("rewrites revised-tail dependencies that still point at the failed step", () => {
    const steps: StepRecord[] = [
      completedStep(basePlan.steps[0], "scoped"),
      completedStep(basePlan.steps[1], "first pass"),
      { ...pendingStep(basePlan.steps[2]), status: "running", output: "wrong shape" },
      {
        id: "s4",
        title: "Original downstream step",
        rationale: "Old tail",
        agentRole: "growth",
        dependsOn: ["s3"],
        expectedOutput: "Old downstream output",
        riskLevel: "medium",
        needsApproval: false,
        status: "pending",
      },
    ];

    const revisedTail: OrchestrationStep[] = [
      {
        id: "s5",
        title: "Recovery deliverable",
        rationale: "Corrected path",
        agentRole: "engineer",
        dependsOn: ["s3"],
        expectedOutput: "Fixed output",
        riskLevel: "medium",
        needsApproval: false,
      },
      {
        id: "s6",
        title: "Consolidate recovery output",
        rationale: "Wrap up",
        agentRole: "ceo",
        dependsOn: ["s5"],
        expectedOutput: "Summary",
        riskLevel: "low",
        needsApproval: false,
      },
    ];

    const next = applyRevisedPlanTail({ steps, failedStepId: "s3", revisedTail });

    expect(next.find((step) => step.id === "s4")).toBeUndefined();
    expect(next.find((step) => step.id === "s5")).toMatchObject({
      status: "pending",
      dependsOn: ["s2"],
    });
    expect(next.find((step) => step.id === "s6")).toMatchObject({
      status: "pending",
      dependsOn: ["s5"],
    });
  });
});

describe("reviseOrchestrationPlanTail", () => {
  it("returns a tail that depends on completed steps when the planner is unavailable", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    const company = await store.createCompany({
      name: `Replan Co ${makeId("test")}`,
      brief: { vision: "structural recovery" },
    });

    const plan = await reviseOrchestrationPlanTail(company, basePlan.objective, "", {
      plan: basePlan,
      completedSteps: [completedStep(basePlan.steps[0], "scoped")],
      failedStep: { ...pendingStep(basePlan.steps[1]), status: "running", output: "wrong toolchain" },
      critique: { verdict: "replan", reason: "plan assumed Python but repo is TypeScript" },
    });

    expect(plan.steps.some((step) => step.id === "s1")).toBe(true);
    expect(plan.steps.length).toBeGreaterThan(1);
    const tail = plan.steps.filter((step) => step.id !== "s1");
    expect(tail.some((step) => step.dependsOn.includes("s1"))).toBe(true);
    expect(tail.some((step) => /recover|revised|correct/i.test(step.title))).toBe(true);
    vi.unstubAllEnvs();
  });

  it("normalizes near-valid replan labels, booleans, and string arrays", async () => {
    mockAi.callJson.mockImplementation(async (_model, _system, _user, schema) => ({
      data: schema.parse({
        reasoning: "near-valid tail revision",
        steps: [
          {
            id: "s4",
            title: "Analyze available operating data",
            rationale: "Recover with a data-first path",
            agentRole: "data analyst",
            dependsOn: "s1",
            expectedOutput: "Grounded operating priorities",
            riskLevel: "Moderate",
            needsApproval: "false",
          },
          {
            id: "s5",
            title: "Consolidate revised output",
            rationale: "Make the recovery founder-readable",
            agentRole: "team_lead",
            dependsOn: "s4",
            expectedOutput: "Founder-ready summary",
            riskLevel: "Low",
            needsApproval: "true",
          },
        ],
        successCriteria: "Produce a revised grounded priority brief",
        blockers: null,
      }),
    }));
    const company = await store.createCompany({
      name: `Near Valid Replan ${makeId("test")}`,
      brief: { vision: "schema tolerance" },
    });

    const plan = await reviseOrchestrationPlanTail(company, basePlan.objective, "", {
      plan: basePlan,
      completedSteps: [completedStep(basePlan.steps[0], "scoped")],
      failedStep: { ...pendingStep(basePlan.steps[1]), status: "running", output: "wrong shape" },
      critique: { verdict: "replan", reason: "plan needs a data-first recovery path" },
    });

    expect(plan.reasoning).toBe("near-valid tail revision");
    expect(plan.successCriteria).toEqual(["Produce a revised grounded priority brief"]);
    expect(plan.blockers).toEqual([]);
    // "data analyst" resolves to the analyst seat again: the 2026-07-01 shrink that folded it
    // into ceo was reverted on 2026-09-18 (orchestrator-runtime.ts, ACTIVE_SEATS).
    expect(plan.steps.find((step) => step.id === "s4")).toMatchObject({
      agentRole: "analyst",
      dependsOn: ["s1"],
      riskLevel: "medium",
      needsApproval: false,
    });
    expect(plan.steps.find((step) => step.id === "s5")).toMatchObject({
      agentRole: "ceo",
      dependsOn: ["s4"],
      riskLevel: "low",
      needsApproval: true,
    });
  });
});

describe("buildReplanPlanningPrompts", () => {
  it("summarizes completed steps via their validated handoff, not raw output", () => {
    const handoff = buildStepHandoff(
      { id: "s1", agentRole: "ceo" },
      { summary: "Scope locked: ship the checklist.", findings: [], recommendations: [], riskNotes: [], whatIDidNotDo: [], artifactRefs: [] },
      "RAW ceo output that should not drive replanning",
    );
    const completed: StepRecord = {
      ...basePlan.steps[0]!,
      status: "completed",
      handoff,
      output: "RAW ceo output that should not drive replanning",
      completedAt: new Date().toISOString(),
    };
    const prompt = buildReplanPlanningPrompts(
      { id: "co1", name: "Co", brief: { vision: "v" } } as any,
      "Ship a revised checklist",
      "",
      {
        plan: basePlan,
        completedSteps: [completed],
        failedStep: { ...basePlan.steps[1]!, status: "failed", output: "bad" },
        critique: { verdict: "replan", reason: "wrong shape" },
      },
    );

    expect(prompt.user).toContain("Scope locked: ship the checklist.");
    expect(prompt.user).not.toContain("RAW ceo output that should not drive replanning");
  });
});

describe("buildEscalationReplanPrompt", () => {
  it("attaches the proposed replan so the founder can approve a new path", () => {
    const prompt = buildEscalationReplanPrompt(
      { ...pendingStep(basePlan.steps[1]), status: "blocked" },
      { verdict: "escalate", reason: "unsafe to continue autonomously" },
      {
        ...basePlan,
        steps: [
          basePlan.steps[0],
          {
            id: "s4",
            title: "Human-reviewed recovery path",
            rationale: "Founder must approve",
            agentRole: "engineer",
            dependsOn: ["s1"],
            expectedOutput: "Approved deliverable",
            riskLevel: "high",
            needsApproval: true,
          },
        ],
        reasoning: "Proposed tail revision after structural failure",
      },
    );

    expect(prompt).toContain("unsafe to continue autonomously");
    expect(prompt).toContain("Proposed replan");
    expect(prompt).toContain("Human-reviewed recovery path");
    expect(prompt).toMatch(/approve|new path/i);
  });
});

describe("handleStepCritique", () => {
  let companyId: string;

  beforeEach(async () => {
    const company = await store.createCompany({
      name: `Critique Handler ${makeId("test")}`,
      brief: { vision: "replan handling" },
    });
    companyId = company.id;
  });

  it("applies a structural replan and preserves completed steps for re-execution", async () => {
    const run: OrchestrationRun = {
      id: makeId("orc"),
      companyId,
      objective: basePlan.objective,
      status: "running",
      plan: basePlan,
      replanCount: 0,
      steps: [
        completedStep(basePlan.steps[0], "scoped"),
        { ...pendingStep(basePlan.steps[1]), status: "running", output: "wrong shape" },
        pendingStep(basePlan.steps[2]),
      ],
      startedAt: new Date().toISOString(),
      trigger: "manual",
    };

    const result = await handleStepCritique({
      run,
      stepId: "s2",
      critique: { verdict: "replan", reason: "plan shape was wrong" },
      revisedTail: [
        {
          id: "s4",
          title: "Recovery deliverable",
          rationale: "Corrected path",
          agentRole: "engineer",
          dependsOn: ["s1"],
          expectedOutput: "Fixed output",
          riskLevel: "medium",
          needsApproval: false,
        },
        {
          id: "s5",
          title: "Consolidate",
          rationale: "Done",
          agentRole: "ceo",
          dependsOn: ["s4"],
          expectedOutput: "Summary",
          riskLevel: "low",
          needsApproval: false,
        },
      ],
    });

    expect(result.action).toBe("replan_applied");
    expect(run.replanCount).toBe(1);
    expect(run.steps.find((step) => step.id === "s1")).toMatchObject({ status: "completed" });
    expect(run.steps.find((step) => step.id === "s2")).toMatchObject({ status: "failed" });
    expect(run.steps.find((step) => step.id === "s4")).toMatchObject({ status: "pending" });
    expect(run.steps.find((step) => step.id === "s3")).toBeUndefined();
  });

  it("escalates without auto-applying when the replan budget is exhausted", async () => {
    const run: OrchestrationRun = {
      id: makeId("orc"),
      companyId,
      objective: basePlan.objective,
      status: "running",
      plan: basePlan,
      replanCount: MAX_REPLANS,
      steps: [
        completedStep(basePlan.steps[0], "scoped"),
        { ...pendingStep(basePlan.steps[1]), status: "running", output: "still wrong" },
        pendingStep(basePlan.steps[2]),
      ],
      startedAt: new Date().toISOString(),
      trigger: "manual",
    };

    const result = await handleStepCritique({
      run,
      stepId: "s2",
      critique: { verdict: "replan", reason: "still structurally wrong" },
      proposedReplan: {
        ...basePlan,
        reasoning: "Would revise again but budget is spent",
        steps: [basePlan.steps[0], basePlan.steps[1]],
      },
    });

    expect(result.action).toBe("escalate");
    expect(run.steps.find((step) => step.id === "s2")).toMatchObject({ status: "blocked" });
    if (result.action === "escalate") {
      expect(result.founderPrompt).toContain("Would revise again");
    }
  });

  it("persists replanCount and restores it after crash-resume so further replans are refused", async () => {
    const runId = makeId("orc");
    await store.createOrchestratorRun({
      id: runId,
      companyId,
      objective: basePlan.objective,
      trigger: "manual",
      status: "running",
      modelPolicy: { planner: "gpt-5.2", specialist: "gpt-4.1-mini" },
      budgetCents: 0,
      costCents: 0,
      replanCount: MAX_REPLANS,
    });

    deleteCachedOrchestrationRun(runId);

    const hydrated = await hydrateOrchestrationRun(runId);
    expect(hydrated).toBeDefined();
    expect(hydrated!.replanCount).toBe(MAX_REPLANS);
    expect(canApplyReplan(hydrated!.replanCount ?? 0)).toBe(false);

    hydrated!.plan = basePlan;
    hydrated!.steps = [
      completedStep(basePlan.steps[0], "scoped"),
      { ...pendingStep(basePlan.steps[1]), status: "running", output: "still wrong" },
      pendingStep(basePlan.steps[2]),
    ];

    const result = await handleStepCritique({
      run: hydrated!,
      stepId: "s2",
      critique: { verdict: "replan", reason: "would exceed budget after resume" },
      revisedTail: [
        {
          id: "s4",
          title: "Recovery deliverable",
          rationale: "Should not apply",
          agentRole: "engineer",
          dependsOn: ["s1"],
          expectedOutput: "Fixed output",
          riskLevel: "medium",
          needsApproval: false,
        },
      ],
    });

    expect(result.action).toBe("escalate");
    expect(hydrated!.replanCount).toBe(MAX_REPLANS);
  });

  it("persists incremented replanCount to the store on replan_applied", async () => {
    const runId = makeId("orc");
    await store.createOrchestratorRun({
      id: runId,
      companyId,
      objective: basePlan.objective,
      trigger: "manual",
      status: "running",
      modelPolicy: { planner: "gpt-5.2", specialist: "gpt-4.1-mini" },
      budgetCents: 0,
      costCents: 0,
      replanCount: 0,
    });

    const run: OrchestrationRun = {
      id: runId,
      companyId,
      objective: basePlan.objective,
      status: "running",
      plan: basePlan,
      replanCount: 0,
      steps: [
        completedStep(basePlan.steps[0], "scoped"),
        { ...pendingStep(basePlan.steps[1]), status: "running", output: "wrong shape" },
        pendingStep(basePlan.steps[2]),
      ],
      startedAt: new Date().toISOString(),
      trigger: "manual",
    };

    const result = await handleStepCritique({
      run,
      stepId: "s2",
      critique: { verdict: "replan", reason: "plan shape was wrong" },
      revisedTail: [
        {
          id: "s4",
          title: "Recovery deliverable",
          rationale: "Corrected path",
          agentRole: "engineer",
          dependsOn: ["s1"],
          expectedOutput: "Fixed output",
          riskLevel: "medium",
          needsApproval: false,
        },
      ],
    });

    expect(result.action).toBe("replan_applied");
    const persisted = await store.getOrchestratorRun(runId);
    expect(persisted?.replanCount).toBe(1);
  });

  it("updates the run plan with the sanitized revised tail", async () => {
    const run: OrchestrationRun = {
      id: makeId("orc"),
      companyId,
      objective: basePlan.objective,
      status: "running",
      plan: basePlan,
      replanCount: 0,
      steps: [
        completedStep(basePlan.steps[0], "scoped"),
        completedStep(basePlan.steps[1], "first pass"),
        { ...pendingStep(basePlan.steps[2]), status: "running", output: "wrong shape" },
      ],
      startedAt: new Date().toISOString(),
      trigger: "manual",
    };

    const result = await handleStepCritique({
      run,
      stepId: "s3",
      critique: { verdict: "replan", reason: "tail depended on broken consolidation" },
      revisedTail: [
        {
          id: "s4",
          title: "Recovery deliverable",
          rationale: "Corrected path",
          agentRole: "engineer",
          dependsOn: ["s3"],
          expectedOutput: "Fixed output",
          riskLevel: "medium",
          needsApproval: false,
        },
      ],
    });

    expect(result.action).toBe("replan_applied");
    expect(run.steps.find((step) => step.id === "s4")).toMatchObject({ dependsOn: ["s2"] });
    expect(run.plan?.steps.find((step) => step.id === "s4")).toMatchObject({ dependsOn: ["s2"] });
  });
});
