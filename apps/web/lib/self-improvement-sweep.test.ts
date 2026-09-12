import { describe, it, expect } from "vitest";
import { runSelfImprovementSweep } from "@/lib/heartbeat";
import { InMemoryTraceStore } from "@/lib/trace-store";
import { InMemorySkillDraftStore } from "@/lib/skill-foundry";
import type { TraceRecord } from "@/lib/trace-store";
import type { EvalSuiteInput } from "@/lib/eval-harness";

function trace(overrides: Partial<TraceRecord> = {}): TraceRecord {
  return {
    id: "t1",
    companyId: "c1",
    runId: "r1",
    taskType: "churn_analysis",
    agentRole: "analyst",
    stepTitle: "Analyze cohorts",
    status: "completed",
    toolCalls: ["sql_query", "chart"],
    toolCallCount: 2,
    costCents: 10,
    humanCorrected: false,
    createdAt: "2026-06-02T00:00:00.000Z",
    critiqueVerdict: "pass",
    ...overrides,
  };
}

function passingSuite(): Omit<EvalSuiteInput, "subjectId" | "previousScore"> {
  return {
    subjectType: "seat",
    version: "v1",
    fixtures: [
      {
        id: "f1",
        rubricId: "r1",
        input: "test",
        actual: { text: "test output" },
        graders: [{ type: "contains", weight: 1, values: ["test"] }],
      },
    ],
  };
}

describe("runSelfImprovementSweep", () => {
  it("returns zero counts when trace store is empty", async () => {
    const report = await runSelfImprovementSweep("c1", {
      traceStore: new InMemoryTraceStore(),
      draftStore: new InMemorySkillDraftStore(),
      skipLLM: true,
    });
    expect(report.skillsDistilled).toBe(0);
    expect(report.skillsPromoted).toBe(0);
    expect(report.gepaPasses).toBe(0);
    expect(report.errors).toHaveLength(0);
  });

  it("distills a skill when trigger fires from traces", async () => {
    const traceStore = new InMemoryTraceStore();
    // 5 tool calls → tool_call_threshold fires
    await traceStore.append(trace({ id: "t1", toolCallCount: 3 }));
    await traceStore.append(trace({ id: "t2", toolCallCount: 2 }));

    const report = await runSelfImprovementSweep("c1", {
      traceStore,
      draftStore: new InMemorySkillDraftStore(),
      skipLLM: true,
    });
    expect(report.skillsDistilled).toBe(1);
    expect(report.errors).toHaveLength(0);
  });

  it("does not distill when trigger does not fire", async () => {
    const traceStore = new InMemoryTraceStore();
    // Only 2 tool calls total → below threshold, no other triggers
    await traceStore.append(trace({ id: "t1", toolCallCount: 1, evalScore: 0.3 }));

    const report = await runSelfImprovementSweep("c1", {
      traceStore,
      draftStore: new InMemorySkillDraftStore(),
      skipLLM: true,
    });
    expect(report.skillsDistilled).toBe(0);
  });

  it("promotes a distilled skill when gate passes (passing suite)", async () => {
    const traceStore = new InMemoryTraceStore();
    await traceStore.append(trace({ toolCallCount: 5 }));

    const draftStore = new InMemorySkillDraftStore();
    const report = await runSelfImprovementSweep("c1", {
      traceStore,
      draftStore,
      frozenSuite: passingSuite(),
      evalBaseline: { score: 0.5, failureClusters: {} },
      skipLLM: true,
    });
    expect(report.skillsDistilled).toBe(1);
    expect(report.skillsPromoted).toBe(1);
    const live = await draftStore.readLive("c1", "churn_analysis");
    expect(live).toBeDefined();
  });

  it("does not promote when gate blocks (regression)", async () => {
    const traceStore = new InMemoryTraceStore();
    await traceStore.append(trace({ toolCallCount: 5 }));

    const draftStore = new InMemorySkillDraftStore();
    // Baseline score is 1.0 but suite always passes with score 1.0 → delta = 0 → should promote
    // Use a very high baseline that won't be matched
    const failingSuite: Omit<EvalSuiteInput, "subjectId" | "previousScore"> = {
      subjectType: "seat",
      version: "v1",
      fixtures: [
        {
          id: "f1",
          rubricId: "r1",
          input: "test",
          actual: { text: "wrong" },
          graders: [{ type: "contains", weight: 1, values: ["MISSING_TOKEN"] }],
        },
      ],
    };
    const report = await runSelfImprovementSweep("c1", {
      traceStore,
      draftStore,
      frozenSuite: failingSuite,
      evalBaseline: { score: 1.0, failureClusters: {} },
      skipLLM: true,
    });
    expect(report.skillsDistilled).toBe(1);
    expect(report.skillsPromoted).toBe(0);
  });

  it("runs a GEPA pass when rolePrompt + suite + baseline are provided", async () => {
    const traceStore = new InMemoryTraceStore();
    // Add some failing traces for the analyst role
    await traceStore.append(trace({ id: "t1", toolCallCount: 5, critiqueVerdict: "retry", evalScore: 0.4 }));
    await traceStore.append(trace({ id: "t2", toolCallCount: 0, critiqueVerdict: "retry", evalScore: 0.5 }));

    const report = await runSelfImprovementSweep("c1", {
      traceStore,
      draftStore: new InMemorySkillDraftStore(),
      frozenSuite: passingSuite(),
      evalBaseline: { score: 0.5, failureClusters: {} },
      rolePrompt: "You are Trent's analyst agent.",
      skipLLM: true,
    });
    expect(report.gepaPasses).toBe(1);
    expect(typeof report.gepaBestScore).toBe("number");
  });

  it("captures errors per task type without aborting the whole sweep", async () => {
    const traceStore = new InMemoryTraceStore();
    await traceStore.append(trace({ toolCallCount: 5 }));

    // Draft store that throws on writeQuarantine
    const badDraftStore = {
      writeQuarantine: async () => { throw new Error("disk full"); },
      readQuarantine: async () => undefined,
      promote: async () => {},
      readLive: async () => undefined,
      listLiveTaskTypes: async () => [],
    };

    const report = await runSelfImprovementSweep("c1", {
      traceStore,
      draftStore: badDraftStore,
      skipLLM: true,
    });
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]).toContain("disk full");
    expect(report.skillsDistilled).toBe(0);
  });

  it("proposes DERIVED variants of live skills when company context is provided", async () => {
    const traceStore = new InMemoryTraceStore();
    await traceStore.append(trace({ toolCallCount: 5 }));

    const draftStore = new InMemorySkillDraftStore();
    await draftStore.writeQuarantine("c1", "cold_outreach", "## Steps\n1. research");
    await draftStore.promote("c1", "cold_outreach");

    const report = await runSelfImprovementSweep("c1", {
      traceStore,
      draftStore,
      companyContext: { label: "B2B SaaS", specialization: "Lead with integration depth." },
      skipLLM: true,
    });
    expect(report.skillsDerived).toBe(1);
    const child = await draftStore.readQuarantine("c1", "cold_outreach@b2b-saas");
    expect(child).toContain("## Specialization — B2B SaaS");
  });

  it("does not derive when no company context is provided", async () => {
    const traceStore = new InMemoryTraceStore();
    await traceStore.append(trace({ toolCallCount: 5 }));
    const report = await runSelfImprovementSweep("c1", {
      traceStore,
      draftStore: new InMemorySkillDraftStore(),
      skipLLM: true,
    });
    expect(report.skillsDerived).toBe(0);
  });

  it("groups traces by task type and distills once per type", async () => {
    const traceStore = new InMemoryTraceStore();
    // Two task types, each with enough tool calls
    await traceStore.append(trace({ id: "t1", taskType: "churn_analysis", toolCallCount: 5 }));
    await traceStore.append(trace({ id: "t2", taskType: "growth_experiment", toolCallCount: 5 }));

    const report = await runSelfImprovementSweep("c1", {
      traceStore,
      draftStore: new InMemorySkillDraftStore(),
      skipLLM: true,
    });
    expect(report.skillsDistilled).toBe(2);
  });
});
