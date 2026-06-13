import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { store } from "@/lib/store";
import {
  auditTransition,
  buildConsolidationUserPrompt,
  buildStepHandoff,
  buildOrchestrationPlanningPrompts,
  consolidateRun,
  critiqueStepOutput,
  executeStepWithRuntime,
  generateOrchestrationPlan,
  normalizePlannerAgentRole,
  renderDependencyHandoff,
  repairOrchestrationPlanRoutes,
  toolForStep,
} from "@/lib/orchestrator-runtime";
import type { OrchestrationStep, RuntimeStep } from "@/lib/orchestrator-runtime";
import { makeId, nowIso } from "@/lib/utils";
import {
  clearRuntimeEvalOverrides,
  setRuntimeEvalOverrides,
} from "@/lib/runtime-eval-overrides";

const mockJobEvents = vi.hoisted(() => ({ emitJobEvent: vi.fn() }));
vi.mock("@/lib/job-events", () => mockJobEvents);

const mockWikiEmbeddings = vi.hoisted(() => ({
  semanticSearch: vi.fn(async () => [] as Array<{
    noteId: string;
    title: string;
    path: string;
    chunkIdx: number;
    text: string;
    score: number;
  }>),
}));
vi.mock("@/lib/wiki-embeddings", () => mockWikiEmbeddings);

const mockSpend = vi.hoisted(() => ({
  assertSpendAvailable: vi.fn().mockResolvedValue(undefined),
  assertAgentTokenBudget: vi.fn().mockResolvedValue(undefined),
}));

const mockRuntime = vi.hoisted(() => ({
  getAgentRuntime: vi.fn().mockResolvedValue({
    role: "engineer",
    slotContract: { mission: "ship code" },
    profile: { name: "Senior Eng" },
    environment: { tools: [], approvalRequiredFor: [], budgetCentsPerRun: 50 },
    systemPrompt: "SYS",
  }),
}));

const mockGateway = vi.hoisted(() => ({
  executeSeatModel: vi.fn().mockResolvedValue({
    output: { summary: "did the work ↗ next: review", findings: [], recommendations: [] },
    model: "gpt-4o",
    tokens: 1200,
    costCents: 2,
    fallback: false,
  }),
}));

vi.mock("@/lib/spend", () => mockSpend);
vi.mock("@/lib/agent-runtime", () => mockRuntime);
vi.mock("@/lib/model-gateway", () => mockGateway);

describe("Cycle.kind discriminator", () => {
  it("defaults saved cycles to scheduled when no kind is provided", async () => {
    const company = await store.createCompany({
      name: `Cycle Kind ${makeId("test")}`,
      brief: { vision: "verify orchestration cycle kind" },
    });

    await store.saveCycle({
      id: makeId("cycle"),
      companyId: company.id,
      trigger: "manual",
      status: "running",
      phases: ["plan"],
      summary: "Cycle is running.",
      startedAt: nowIso(),
    } as any);

    const [cycle] = await store.listCycles(company.id);
    expect(cycle.kind).toBe("scheduled");
  });
});

describe("toolForStep", () => {
  const environment = { tools: ["GitHub", "Slack"] };

  it("returns the adapter when the step names an allowed tool", async () => {
    const tool = await toolForStep("create GitHub issue for the bug", environment);
    expect(tool?.name).toBe("GitHub");
  });

  it("returns undefined when the named tool is not in environment.tools", async () => {
    const tool = await toolForStep("charge the customer via Stripe", environment);
    expect(tool).toBeUndefined();
  });

  it("returns undefined when no tool keyword is present", async () => {
    const tool = await toolForStep("summarize the findings", environment);
    expect(tool).toBeUndefined();
  });
});

describe("buildOrchestrationPlanningPrompts", () => {
  it("injects the full seat dossier, runtime environments, and objective routing hint", () => {
    const prompts = buildOrchestrationPlanningPrompts(
      {
        id: "co_1",
        name: "Routing Co",
        brief: { vision: "route work correctly", goals: "ship", icp: "founders" },
      } as any,
      "Use Fincept Terminal to produce a finance risk report.",
      "prior memory",
    );

    expect(prompts.system).toContain("CEO routing dossier");
    expect(prompts.system).toContain("Fincept Terminal");
    expect(prompts.system).toContain("HyperFrames");
    expect(prompts.system).toContain("Steel Browser");
    expect(prompts.system).toContain("Recommended route for this objective: finance via Fincept Terminal");
  });

  it("instructs the planner to engage every specialist seat in full-team (autonomous) mode", () => {
    const prompts = buildOrchestrationPlanningPrompts(
      { id: "co_1", name: "Co", brief: { vision: "v", goals: "g", icp: "i" } } as any,
      "Run the whole company.",
      "",
      { fullTeam: true },
    );
    expect(prompts.system).toContain("FULL AUTONOMOUS COMPANY RUN");
    expect(prompts.system).toContain("engineer, growth, content, support, analyst, finance, sales");
  });

  it("asks model plans to emit per-step acceptance criteria", () => {
    const prompts = buildOrchestrationPlanningPrompts(
      { id: "co_1", name: "Co", brief: { vision: "v", goals: "g", icp: "i" } } as any,
      "Research competitors and draft a launch plan.",
      "",
    );

    expect(prompts.system).toContain("acceptance");
    expect(prompts.user).toContain("spec");
  });

  it("includes grounded source documents and coverage in the planner prompt", () => {
    const prompts = buildOrchestrationPlanningPrompts(
      { id: "co_1", name: "Co", brief: { vision: "v", goals: "g", icp: "i" } } as any,
      "Audit the roadmap.",
      "",
      {
        sourceCoverage: "SOURCE COVERAGE:\n- Available: roadmap (doc wiki:roadmap#0)\n- Missing: none",
        sourceDocuments: "SOURCE DOCUMENTS (cite by id when you use one):\n[wiki:roadmap#0] Roadmap Wiki\nRoadmap priorities.",
      },
    );

    expect(prompts.user).toContain("SOURCE COVERAGE");
    expect(prompts.user).toContain("SOURCE DOCUMENTS");
    expect(prompts.user).toContain("[wiki:roadmap#0]");
    expect(prompts.user).toContain("cite their ids");
  });

  it("injects the content publishing mission protocol for social/ads objectives", () => {
    const prompts = buildOrchestrationPlanningPrompts(
      { id: "co_1", name: "Co", brief: { vision: "v", goals: "g", icp: "i" } } as any,
      "Research viral ideas, make videos, publish, reply to DMs, and run ads.",
      "",
    );

    expect(prompts.system).toContain("CONTENT PUBLISHING MISSION");
    expect(prompts.system).toContain("Route research/viral trend discovery to analyst");
    expect(prompts.system).toContain("Route paid spend");
  });
});

describe("generateOrchestrationPlan — autonomous full-team fallback", () => {
  afterEach(() => {
    clearRuntimeEvalOverrides();
    vi.unstubAllEnvs();
  });

  it("engages every specialist seat when the LLM is unavailable", async () => {
    // No OPENAI_API_KEY in test env → deterministic fallback path.
    const plan = await generateOrchestrationPlan(
      { id: "co_1", name: "Co", brief: { vision: "v", goals: "g", icp: "i" } } as any,
      "Run the whole company autonomously.",
      "",
      { fullTeam: true },
    );
    const roles = new Set(plan.steps.map((s) => s.agentRole));
    for (const seat of ["engineer", "growth", "content", "support", "analyst", "finance", "sales"]) {
      expect(roles.has(seat as never)).toBe(true);
    }
    // CEO bookends: scope first, consolidate last.
    expect(plan.steps[0].agentRole).toBe("ceo");
    expect(plan.steps[plan.steps.length - 1].agentRole).toBe("ceo");
    // Final consolidation depends on all specialist steps.
    expect(plan.steps[plan.steps.length - 1].dependsOn.length).toBe(7);
  });

  it("adds acceptance specs to fallback orchestration steps", async () => {
    const plan = await generateOrchestrationPlan(
      { id: "co_1", name: "Co", brief: { vision: "v", goals: "g", icp: "i" } } as any,
      "Ship the landing page.",
      "",
    );

    expect(plan.steps.every((step) => (step as any).spec?.acceptance?.length > 0)).toBe(true);
  });

  it("falls back instead of returning a semantically invalid generated DAG when validation is enabled", async () => {
    vi.stubEnv("ORCHESTRATION_PLAN_VALIDATOR_ENABLED", "1");
    setRuntimeEvalOverrides({
      orchestration: {
        createCompletion: async () => ({
          totalTokens: 42,
          content: JSON.stringify({
            objective: "Ship the landing page.",
            reasoning: "invalid model plan",
            steps: [{
              id: "bad_1",
              title: "Bad dependency",
              rationale: "model hallucinated an edge",
              agentRole: "engineer",
              dependsOn: ["missing_step"],
              expectedOutput: "Landing page shipped",
              riskLevel: "medium",
              needsApproval: false,
              spec: { acceptance: ["Landing page shipped"], inputsFrom: ["missing_step"] },
            }],
            successCriteria: ["Landing page shipped"],
            blockers: [],
          }),
        }),
      },
    });

    const plan = await generateOrchestrationPlan(
      { id: "co_1", name: "Co", brief: { vision: "v", goals: "g", icp: "i" } } as any,
      "Ship the landing page.",
      "",
    );

    expect(plan.reasoning).toContain("deterministic fallback");
    expect(plan.steps.map((step) => step.id)).not.toContain("bad_1");
    expect(plan.steps.every((step) => (step as any).spec?.acceptance?.length > 0)).toBe(true);
  });

  it("normalizes human planner role and risk labels before schema validation", async () => {
    setRuntimeEvalOverrides({
      orchestration: {
        createCompletion: async () => ({
          totalTokens: 42,
          content: JSON.stringify({
            objective: "Identify top priorities.",
            reasoning: "near-valid model plan",
            steps: [
              {
                id: "s1",
                title: "Analyze sources",
                rationale: "research the inputs",
                agentRole: "Research / Analyst",
                dependsOn: [],
                expectedOutput: "Source-grounded findings",
                riskLevel: "Low",
                needsApproval: "false",
                spec: { acceptance: ["Findings cite docs"], inputsFrom: [] },
              },
              {
                id: "s2",
                title: "Plan implementation",
                rationale: "make the engineering path concrete",
                agentRole: "Engineer",
                dependsOn: "s1",
                expectedOutput: "Implementation plan",
                riskLevel: "Medium",
                needsApproval: "false",
                spec: { acceptance: ["Plan is actionable"], inputsFrom: "s1" },
              },
              {
                id: "s3",
                title: "Consolidate",
                rationale: "summarize",
                agentRole: "Project Manager",
                dependsOn: "s1, s2",
                expectedOutput: "Founder report",
                riskLevel: "High",
                needsApproval: "true",
                spec: { acceptance: ["Report is decision-ready"], inputsFrom: ["s1", "s2"] },
              },
            ],
            successCriteria: "Priorities are clear",
            blockers: null,
          }),
        }),
      },
    });

    const plan = await generateOrchestrationPlan(
      { id: "co_labels", name: "Co", brief: { vision: "v", goals: "g", icp: "i" } } as any,
      "Identify top priorities.",
      "",
    );

    expect(plan.reasoning).toBe("near-valid model plan");
    expect(plan.steps.map((step) => step.agentRole)).toEqual(["analyst", "engineer", "ceo"]);
    expect(plan.steps.map((step) => step.riskLevel)).toEqual(["low", "medium", "high"]);
    expect(plan.steps.map((step) => step.dependsOn)).toEqual([[], ["s1"], ["s1", "s2"]]);
    expect(plan.steps.map((step) => step.needsApproval)).toEqual([false, false, false]);
    expect(plan.successCriteria).toEqual(["Priorities are clear"]);
    expect(plan.blockers).toEqual([]);
  });

  it("normalizes common marketing role synonyms to growth", () => {
    expect(normalizePlannerAgentRole("marketer")).toBe("growth");
    expect(normalizePlannerAgentRole("strategist")).toBe("analyst");
    expect(normalizePlannerAgentRole("manager")).toBe("analyst");
    expect(normalizePlannerAgentRole("totally custom role")).toBe("analyst");
  });

  it("strips approval gates from read-only implementation-plan objectives", async () => {
    setRuntimeEvalOverrides({
      orchestration: {
        createCompletion: async () => ({
          totalTokens: 42,
          content: JSON.stringify({
            objective: "Identify the safest high-impact engineering task.",
            reasoning: "near-valid read-only plan",
            steps: [
              {
                id: "s1",
                title: "Prepare implementation plan",
                rationale: "Plan the safest task",
                agentRole: "engineer",
                dependsOn: [],
                expectedOutput: "Implementation plan only",
                riskLevel: "high",
                needsApproval: true,
                spec: { acceptance: ["Plan is actionable"], inputsFrom: [] },
              },
              {
                id: "s2",
                title: "Consolidate",
                rationale: "Summarize the plan",
                agentRole: "ceo",
                dependsOn: ["s1"],
                expectedOutput: "Founder-readable summary",
                riskLevel: "low",
                needsApproval: true,
                spec: { acceptance: ["Summary is clear"], inputsFrom: ["s1"] },
              },
            ],
            successCriteria: ["Plan is created"],
            blockers: [],
          }),
        }),
      },
    });

    const plan = await generateOrchestrationPlan(
      { id: "co_readonly", name: "Co", brief: { vision: "v", goals: "g", icp: "i" } } as any,
      "Identify the safest high-impact engineering task to do next. Create an implementation plan. Do not make changes.",
      "",
    );

    expect(plan.reasoning).toBe("near-valid read-only plan");
    expect(plan.steps.every((step) => step.needsApproval === false)).toBe(true);
  });

  it("does not turn approval-reporting analysis into a blocking approval gate", async () => {
    setRuntimeEvalOverrides({
      orchestration: {
        createCompletion: async () => ({
          totalTokens: 42,
          content: JSON.stringify({
            objective: "Identify the top 5 priorities and include founder approval yes/no.",
            reasoning: "approval reporting plan",
            steps: [
              {
                id: "s1",
                title: "Conduct priority audit",
                rationale: "Find priorities",
                agentRole: "analyst",
                dependsOn: [],
                expectedOutput: "Top 5 priorities with founder approval yes/no",
                riskLevel: "medium",
                needsApproval: true,
                spec: { acceptance: ["Priorities are ranked"], inputsFrom: [] },
              },
            ],
            successCriteria: ["Priorities are clear"],
            blockers: [],
          }),
        }),
      },
    });

    const plan = await generateOrchestrationPlan(
      { id: "co_priorities", name: "Co", brief: { vision: "v", goals: "g", icp: "i" } } as any,
      "Identify the top 5 priorities for the next 7 days. For each include owner, success metric, risk, and founder approval yes/no.",
      "",
    );

    expect(plan.reasoning).toBe("approval reporting plan");
    expect(plan.steps.every((step) => step.needsApproval === false)).toBe(true);
  });

  it("uses an analysis-only fallback for read-only priority planning when the planner fails", async () => {
    setRuntimeEvalOverrides({
      orchestration: {
        createCompletion: async () => {
          throw new Error("planner unavailable");
        },
      },
    });

    const plan = await generateOrchestrationPlan(
      { id: "co_priorities_fallback", name: "Co", brief: { vision: "v", goals: "g", icp: "i" } } as any,
      "Identify the top 5 priorities for the next 7 days. For each include owner, success metric, risk, and founder approval yes/no.",
      "",
    );

    const planText = plan.steps.map((step) => `${step.title}\n${step.expectedOutput}`).join("\n");
    expect(plan.reasoning).toContain("Read-only analysis fallback");
    expect(planText).not.toContain("audit:create");
    expect(plan.steps.at(-1)?.agentRole).toBe("ceo");
  });

  it("anchors every seat's task to the actual objective (not generic boilerplate)", async () => {
    const objective = "do a financial analysis of all stocks related to spacex and make a slideshow";
    const plan = await generateOrchestrationPlan(
      { id: "co_1", name: "Co", brief: { vision: "v", goals: "g", icp: "i" } } as any,
      objective,
      "",
      { fullTeam: true },
    );
    // Every step's expected output must reference the real objective, so seats
    // do the SpaceX/slideshow work instead of generic ops boilerplate.
    for (const step of plan.steps) {
      expect(step.expectedOutput.toLowerCase()).toContain("spacex");
    }
  });
});

describe("generateOrchestrationPlan — content publishing mission fallback", () => {
  it("coordinates research, creative, approvals, engagement, ads, finance, and measurement", async () => {
    const plan = await generateOrchestrationPlan(
      { id: "co_1", name: "Co", brief: { vision: "v", goals: "g", icp: "i" } } as any,
      "Find viral ideas, create videos, publish them, keep up with comments and DMs, and run ads.",
      "",
    );
    const roles = new Set(plan.steps.map((step) => step.agentRole));

    for (const role of ["analyst", "growth", "content", "support", "sales", "finance", "escalation", "ceo"]) {
      expect(roles.has(role as never)).toBe(true);
    }
    expect(plan.steps[0].agentRole).toBe("analyst");
    expect(plan.steps.some((step) => step.needsApproval && /paid ad|approval packet/i.test(step.title))).toBe(true);
    expect(plan.successCriteria.join(" ")).toContain("approval-gated");
  });
});

describe("repairOrchestrationPlanRoutes", () => {
  it("injects the recommended specialist when a model returns a CEO-only plan for code work", () => {
    const plan = repairOrchestrationPlanRoutes({
      objective: "Build me a notes app in the workbench.",
      reasoning: "model picked CEO-only steps",
      blockers: [],
      successCriteria: ["App works"],
      steps: [
        {
          id: "s1",
          title: "Scope objective",
          rationale: "plan",
          agentRole: "ceo",
          dependsOn: [],
          expectedOutput: "scope",
          riskLevel: "low",
          needsApproval: false,
        },
        {
          id: "s2",
          title: "Consolidate result",
          rationale: "wrap",
          agentRole: "ceo",
          dependsOn: ["s1"],
          expectedOutput: "summary",
          riskLevel: "low",
          needsApproval: false,
        },
      ],
    });

    expect(plan.steps.some((step) => step.agentRole === "engineer")).toBe(true);
    expect(plan.steps.at(-1)?.agentRole).toBe("ceo");
  });

  it("does not inject audit tool workstreams for read-only priority planning", () => {
    const plan = repairOrchestrationPlanRoutes({
      objective: "Identify the top 5 priorities for the next 7 days. For each include owner, risk, and founder approval yes/no.",
      reasoning: "model picked CEO-only steps",
      blockers: [],
      successCriteria: ["Priorities identified"],
      steps: [
        {
          id: "s1",
          title: "Identify priorities",
          rationale: "analysis",
          agentRole: "ceo",
          dependsOn: [],
          expectedOutput: "top priorities with owners and risks",
          riskLevel: "low",
          needsApproval: false,
        },
        {
          id: "s2",
          title: "Consolidate result",
          rationale: "wrap",
          agentRole: "ceo",
          dependsOn: ["s1"],
          expectedOutput: "summary",
          riskLevel: "low",
          needsApproval: false,
        },
      ],
    });

    expect(plan.steps.map((step) => step.title).join("\n")).not.toContain("audit:create");
    expect(plan.steps).toHaveLength(2);
  });
});

describe("executeStepWithRuntime", () => {
  const step: RuntimeStep = {
    id: "s2",
    title: "Open implementation notes",
    agentRole: "engineer",
    rationale: "track work",
    expectedOutput: "implementation notes",
    dependsOn: [],
    riskLevel: "medium",
    needsApproval: false,
  };

  beforeEach(() => {
    mockSpend.assertSpendAvailable.mockClear();
    mockSpend.assertAgentTokenBudget.mockClear();
    mockRuntime.getAgentRuntime.mockClear();
    mockGateway.executeSeatModel.mockClear();
    mockWikiEmbeddings.semanticSearch.mockClear();
  });

  it("checks budget before executing", async () => {
    const company = await store.createCompany({
      name: `Runtime Budget ${makeId("test")}`,
      brief: { vision: "budgeted orchestration" },
    });

    await executeStepWithRuntime({ step, company, previousOutputs: {} });

    expect(mockSpend.assertSpendAvailable).toHaveBeenCalledWith(
      company.id,
      expect.any(Number),
      expect.stringContaining(step.id),
    );
    expect(mockSpend.assertAgentTokenBudget).toHaveBeenCalledWith(company.id, "engineer", expect.any(Number));
  });

  it("returns output plus an execution-row payload", async () => {
    const company = await store.createCompany({
      name: `Runtime Execution ${makeId("test")}`,
      brief: { vision: "persisted orchestration" },
    });

    const result = await executeStepWithRuntime({ step, company, previousOutputs: {}, cycleId: "cycle_1" });

    expect(result.output).toContain("did the work");
    expect(result.execution.companyId).toBe(company.id);
    expect(result.execution.cycleId).toBe("cycle_1");
    expect(result.execution.agentRole).toBe("engineer");
    expect(result.execution.tokens).toBe(1200);
    expect(result.execution.status).toBe("completed");
  });

  it("renders object-shaped findings/recommendations as text, never [object Object]", async () => {
    mockGateway.executeSeatModel.mockResolvedValueOnce({
      output: {
        summary: "SpaceX-adjacent equities reviewed",
        findings: [{ title: "Rocket Lab", detail: "RKLB up 12% MoM" }, { point: "Boeing exposure" }],
        recommendations: [{ recommendation: "Track RKLB earnings" }],
      },
      model: "gpt-4o-mini",
      tokens: 800,
      costCents: 1,
      fallback: false,
    });
    const company = await store.createCompany({
      name: `Runtime Obj ${makeId("test")}`,
      brief: { vision: "object findings" },
    });

    const result = await executeStepWithRuntime({ step, company, previousOutputs: {}, objective: "analyze spacex stocks" });

    expect(result.output).not.toContain("[object Object]");
    expect(result.output).toContain("Rocket Lab — RKLB up 12% MoM");
    expect(result.output).toContain("Track RKLB earnings");
  });

  it("captures seat-emitted riskNotes and whatIDidNotDo into the published handoff", async () => {
    mockGateway.executeSeatModel.mockResolvedValueOnce({
      output: {
        summary: "Analyzed the funnel.",
        findings: ["Drop-off at step 3"],
        recommendations: ["Growth: simplify step 3"],
        riskNotes: ["Sample skews enterprise"],
        whatIDidNotDo: ["Did not segment by channel"],
      },
      model: "gpt-4o-mini",
      tokens: 100,
      costCents: 1,
      fallback: false,
    });
    const company = await store.createCompany({
      name: `Runtime Handoff Emit ${makeId("test")}`,
      brief: { vision: "handoff population" },
    });

    const result = await executeStepWithRuntime({ step, company, previousOutputs: {}, objective: "grow signups" });

    expect(result.handoff.summary).toContain("Analyzed the funnel.");
    expect(result.handoff.nextActions).toContain("Growth: simplify step 3");
    expect(result.handoff.risks).toContain("Sample skews enterprise");
    expect(result.handoff.whatIDidNotDo).toContain("Did not segment by channel");
  });

  it("injects the overall objective into the seat task", async () => {
    let captured: any;
    mockGateway.executeSeatModel.mockImplementationOnce(async (input: any) => {
      captured = input;
      return { output: { summary: "ok", findings: [], recommendations: [] }, model: "gpt-4o-mini", tokens: 10, costCents: 1, fallback: false };
    });
    const company = await store.createCompany({
      name: `Runtime Goal ${makeId("test")}`,
      brief: { vision: "goal propagation" },
    });

    await executeStepWithRuntime({ step, company, previousOutputs: {}, objective: "analyze spacex stocks and make a slideshow" });

    expect(captured.subtask.objective).toContain("analyze spacex stocks and make a slideshow");
    expect(captured.subtask.contextBundle.overallObjective).toBe("analyze spacex stocks and make a slideshow");
  });

  it("injects semantic wiki chunks into seat source documents and coverage", async () => {
    let captured: any;
    mockWikiEmbeddings.semanticSearch.mockResolvedValueOnce([
      {
        noteId: "note_roadmap",
        title: "Roadmap Wiki",
        path: "wiki/roadmap.md",
        chunkIdx: 0,
        text: "Roadmap: import existing projects, then add Playwright verification evidence.",
        score: 0.93,
      },
    ]);
    mockGateway.executeSeatModel.mockImplementationOnce(async (input: any) => {
      captured = input;
      return { output: { summary: "ok", findings: [], recommendations: [] }, model: "gpt-4o-mini", tokens: 10, costCents: 1, fallback: false };
    });
    const company = await store.createCompany({
      name: `Runtime Wiki Grounding ${makeId("test")}`,
      brief: { vision: "ground agents in wiki evidence" },
    });
    const analystStep: RuntimeStep = {
      ...step,
      agentRole: "analyst",
      title: "Audit the roadmap",
      expectedOutput: "Use the roadmap to rank the next build priorities.",
    };

    await executeStepWithRuntime({
      step: analystStep,
      company,
      previousOutputs: {},
      objective: "Audit the roadmap.",
    });

    expect(captured.subtask.contextBundle.sourceDocuments).toContain("[wiki:note_roadmap#0]");
    expect(captured.subtask.contextBundle.sourceDocuments).toContain("Playwright verification");
    expect(captured.subtask.contextBundle.sourceCoverage).toContain("Available: roadmap (doc wiki:note_roadmap#0)");
    expect(captured.subtask.contextBundle.sourceCoverage).toContain("Missing: none");
  });

  it("injects sanitized platform readiness into content/social/ads mission seats", async () => {
    let captured: any;
    mockGateway.executeSeatModel.mockImplementationOnce(async (input: any) => {
      captured = input;
      return { output: { summary: "ok", findings: [], recommendations: [] }, model: "gpt-4o-mini", tokens: 10, costCents: 1, fallback: false };
    });
    const company = await store.createCompany({
      name: `Runtime Platforms ${makeId("test")}`,
      brief: { vision: "content mission platform readiness" },
    });
    await store.upsertSocialAccount({
      companyId: company.id,
      platform: "x",
      externalAccountId: "x_1",
      externalHandle: "@trent",
      scopes: ["read"],
      credentialsRef: "secret_connection_ref",
      autoPublishEnabled: false,
    });
    await store.upsertMarketingAccount({
      companyId: company.id,
      platform: "meta",
      externalAccountId: "act_1",
      externalBusinessId: "biz_1",
      currency: "USD",
      dailyBudgetCents: 0,
      paymentStatus: "needs_payment_method",
      consentForServerEvents: true,
    });
    const growthStep: RuntimeStep = {
      ...step,
      agentRole: "growth",
      title: "Draft TikTok, X, and Meta ad plan",
      expectedOutput: "Plan social publishing and ads without launching.",
    };

    await executeStepWithRuntime({
      step: growthStep,
      company,
      previousOutputs: {},
      objective: "Research viral ideas, publish on TikTok and X, and run Meta ads.",
    });

    const readiness = captured.subtask.contextBundle.platformReadiness;
    expect(readiness.ready).toBe(false);
    expect(readiness.requiredSocialPlatforms).toEqual(["tiktok", "x"]);
    expect(readiness.requiredMarketingPlatforms).toEqual(["meta"]);
    expect(readiness.blockers).toEqual(expect.arrayContaining([
      "tiktok social account is not connected",
      "x post:write scope is missing",
      "x auto-publish is disabled",
      "meta payment status is needs_payment_method",
      "meta daily budget is not configured",
    ]));
    expect(readiness.socialAccounts[0]).toMatchObject({
      platform: "x",
      hasCredentials: true,
      autoPublishEnabled: false,
    });
    expect(JSON.stringify(readiness)).not.toContain("secret_connection_ref");
    const result = await executeStepWithRuntime({
      step: growthStep,
      company,
      previousOutputs: {},
      objective: "Research viral ideas, publish on TikTok and X, and run Meta ads.",
    });
    expect(result.toolCalls).toEqual(expect.arrayContaining([
      expect.objectContaining({
        adapter: "platform_readiness",
        action: "check",
        status: "needs_approval",
        summary: expect.stringContaining("tiktok social account is not connected"),
      }),
    ]));
  });

  it("injects a shared content mission dossier into mission-capable seat context", async () => {
    let captured: any;
    mockGateway.executeSeatModel.mockImplementationOnce(async (input: any) => {
      captured = input;
      return { output: { summary: "ok", findings: [], recommendations: [] }, model: "gpt-4o-mini", tokens: 10, costCents: 1, fallback: false };
    });
    const company = await store.createCompany({
      name: `Runtime Content Mission ${makeId("test")}`,
      brief: { vision: "coordinated social publishing" },
    });
    const contentStep: RuntimeStep = {
      ...step,
      agentRole: "content",
      title: "Create video scripts and captions",
      expectedOutput: "Draft scripts, captions, reply rules, and ad creative without publishing.",
    };

    await executeStepWithRuntime({
      step: contentStep,
      company,
      previousOutputs: {},
      objective: "Research viral ideas, create Higgsfield videos, publish to TikTok and X, reply to DMs, and run Meta ads.",
    });

    const mission = captured.subtask.contextBundle.contentMission;
    expect(mission).toMatchObject({
      kind: "content_social_ads_mission",
      requiredSocialPlatforms: ["tiktok", "x"],
      requiredMarketingPlatforms: ["meta"],
      operatingMode: "draft_only_until_approval",
    });
    expect(mission.stages.map((stage: any) => stage.id)).toContain("market_research");
    expect(mission.stages.map((stage: any) => stage.id)).toContain("ceo_approval_packet");
    expect(mission.seatResponsibilities.content).toContain("scripts");
    expect(mission.approvalGates).toEqual(expect.arrayContaining(["public_publish", "comment_or_dm_reply", "paid_spend_or_boost"]));
  });
});

describe("structured runtime handoffs", () => {
  it("carries next actions, risks, and explicit non-work into downstream dependency context", () => {
    const handoff = buildStepHandoff(
      { id: "s1", agentRole: "analyst" },
      {
        summary: "ICP research completed.",
        findings: ["Enterprise teams have the strongest pain."],
        recommendations: ["Growth should test LinkedIn founder-led copy."],
        riskNotes: ["Survey sample is small."],
        dataCaveats: ["Only public data was reviewed."],
        whatIDidNotDo: ["Did not contact prospects."],
        artifactRefs: ["artifact_research"],
      },
      "Fallback output",
    );

    expect((handoff as any).keyPoints).toEqual(["Enterprise teams have the strongest pain."]);
    expect((handoff as any).nextActions).toEqual(["Growth should test LinkedIn founder-led copy."]);
    expect((handoff as any).risks).toEqual(["Survey sample is small.", "Only public data was reviewed."]);
    expect((handoff as any).whatIDidNotDo).toEqual(["Did not contact prospects."]);

    const rendered = renderDependencyHandoff("s1", handoff, undefined);
    expect(rendered).toContain("NEXT ACTIONS");
    expect(rendered).toContain("RISKS");
    expect(rendered).toContain("NOT DONE");
    expect(rendered).toContain("Growth should test LinkedIn founder-led copy.");
    expect(rendered).toContain("Did not contact prospects.");
  });
});

describe("buildConsolidationUserPrompt", () => {
  const plan = { objective: "Grow signups", successCriteria: ["+20% signups"], steps: [] } as any;

  it("feeds seat handoff summaries, reported risks, and explicit not-done into the brief", () => {
    const analystHandoff = buildStepHandoff(
      { id: "s1", agentRole: "analyst" },
      {
        summary: "Funnel analysis done.",
        findings: ["Drop-off at step 3."],
        recommendations: ["Growth: simplify step 3."],
        riskNotes: ["Sample skews enterprise."],
        whatIDidNotDo: ["Did not segment by channel."],
        artifactRefs: [],
      },
      "RAW analyst output to be ignored",
    );
    const steps = [
      { id: "s1", title: "Analyze funnel", agentRole: "analyst", status: "completed", handoff: analystHandoff, output: "RAW analyst output to be ignored" },
      { id: "s2", title: "Broken step", agentRole: "growth", status: "failed", output: "boom" },
    ] as any;

    const prompt = buildConsolidationUserPrompt(plan, steps);

    expect(prompt).toContain("Funnel analysis done.");
    expect(prompt).not.toContain("RAW analyst output to be ignored");
    expect(prompt).toContain("Seat-reported risks:");
    expect(prompt).toContain("- analyst: Sample skews enterprise.");
    expect(prompt).toContain("Explicitly NOT done");
    expect(prompt).toContain("- analyst: Did not segment by channel.");
    expect(prompt).toContain("Failed (1):");
  });

  it("falls back to raw output for a completed step that published no handoff", () => {
    const steps = [
      { id: "s1", title: "Do thing", agentRole: "engineer", status: "completed", output: "plain output text" },
    ] as any;
    const prompt = buildConsolidationUserPrompt(plan, steps);
    expect(prompt).toContain("plain output text");
    expect(prompt).not.toContain("Seat-reported risks:");
  });
});

describe("consolidateRun", () => {
  it("uses a deterministic CEO approval packet for content/social/ads missions when the model is unavailable", async () => {
    const plan = await generateOrchestrationPlan(
      { id: "co_1", name: "Co", brief: { vision: "v", goals: "g", icp: "i" } } as any,
      "Research viral ideas, create videos, publish to TikTok and X, reply to DMs, and run Meta ads.",
      "",
    );
    const summary = await consolidateRun(plan, [
      {
        ...plan.steps[0],
        status: "completed",
        output: "Analyst found viral examples, competitor hooks, audience pain, and source links.",
      },
      {
        ...plan.steps.find((step) => step.agentRole === "content")!,
        status: "completed",
        output: "Content drafted scripts, captions, CTAs, and video prompts.",
      },
      {
        ...plan.steps.find((step) => step.agentRole === "growth" && /paid ad/i.test(step.title))!,
        status: "blocked",
        output: "Growth drafted ad variants but launch is blocked.",
        toolCalls: [
          {
            adapter: "platform_readiness",
            action: "check",
            status: "needs_approval",
            summary: "Platform readiness blocked external action: x auto-publish is disabled; meta daily budget is not configured",
          },
        ],
      },
    ] as any);

    expect(summary).toContain("## CEO Content Approval Packet");
    expect(summary).toContain("External action status: BLOCKED");
    expect(summary).toContain("Analyst found viral examples");
    expect(summary).toContain("Content drafted scripts");
    expect(summary).toContain("x auto-publish is disabled");
    expect(summary).toContain("No public publish, comment/DM reply, sales send, boost, or ad spend should happen without approval.");
  });
});

describe("auditTransition", () => {
  it("writes an audit row with actor=agent and the run as entity", async () => {
    const company = await store.createCompany({
      name: `Runtime Audit ${makeId("test")}`,
      brief: { vision: "auditable orchestration" },
    });

    await auditTransition(company.id, "run_start", "orc_9", "Started: launch landing page");

    const audits = await store.listAuditLogs(company.id);
    expect(audits.some((audit) => {
      return audit.action === "orchestration.run_start"
        && audit.actor === "agent"
        && audit.objectType === "orchestration"
        && audit.objectId === "orc_9"
        && audit.summary.includes("launch landing page");
    })).toBe(true);
  });
});

describe("operator visibility on genuine LLM failures", () => {
  const critiqueStep: OrchestrationStep = {
    id: "s1",
    title: "Draft launch copy",
    rationale: "ship copy",
    agentRole: "content",
    dependsOn: [],
    expectedOutput: "polished copy",
    riskLevel: "low",
    needsApproval: false,
  };

  beforeEach(() => {
    mockJobEvents.emitJobEvent.mockClear();
  });

  afterEach(() => {
    clearRuntimeEvalOverrides();
    vi.restoreAllMocks();
  });

  it("planner: a real failure (key present, malformed/network error) emits a ⚠ warning event but still returns the deterministic fallback", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // createCompletion present (key configured) but the call genuinely fails —
    // message does NOT contain "not configured".
    setRuntimeEvalOverrides({
      orchestration: {
        createCompletion: async () => {
          throw new Error("429 rate limit exceeded");
        },
      },
    });

    const plan = await generateOrchestrationPlan(
      { id: "co_real_fail", name: "Co", brief: { vision: "v", goals: "g", icp: "i" } } as any,
      "Ship the landing page.",
      "",
      { runId: "orc_real_fail" },
    );

    // Fallback return value is UNCHANGED (deterministic plan with a CEO bookend).
    expect(plan.steps.length).toBeGreaterThan(0);
    expect(plan.steps[0].agentRole).toBe("ceo");

    // Operator-visible signal: a warning job event with the fallback note.
    const warnCall = mockJobEvents.emitJobEvent.mock.calls.find(([event]) =>
      typeof event?.summary === "string" && event.summary.includes("⚠") && event.summary.includes("planner"),
    );
    expect(warnCall).toBeDefined();
    expect(warnCall![0]).toMatchObject({
      jobRunId: "orc_real_fail",
      companyId: "co_real_fail",
      status: "step",
    });
    expect(warnCall![0].summary).toContain("using fallback");
    expect(warnCall![0].summary).toContain("429 rate limit exceeded");
    expect(errorSpy).toHaveBeenCalledWith(
      "orchestrator.llm_failure",
      expect.objectContaining({ stage: "planner" }),
    );
  });

  it("planner: the no-API-key (\"not configured\") offline case stays SILENT and still returns the fallback", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    setRuntimeEvalOverrides({
      orchestration: {
        createCompletion: async () => {
          throw new Error("OPENAI_API_KEY is not configured");
        },
      },
    });

    const plan = await generateOrchestrationPlan(
      { id: "co_offline", name: "Co", brief: { vision: "v", goals: "g", icp: "i" } } as any,
      "Ship the landing page.",
      "",
      { runId: "orc_offline" },
    );

    // Fallback still returned.
    expect(plan.steps.length).toBeGreaterThan(0);
    // No new warning event, no llm_failure log — dev/test output unchanged.
    expect(mockJobEvents.emitJobEvent).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalledWith("orchestrator.llm_failure", expect.anything());
  });

  it("critic: a real failure emits a ⚠ warning event and escalates instead of auto-passing", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    setRuntimeEvalOverrides({
      orchestration: {
        createCompletion: async () => {
          throw new Error("503 upstream model error");
        },
      },
    });

    const verdict = await critiqueStepOutput(critiqueStep, "some output", {
      companyId: "co_critic",
      runId: "orc_critic",
    });

    expect(verdict.verdict).toBe("escalate");
    expect(verdict.reason).toContain("critic LLM call failed");
    expect(verdict.improvement).toContain("human review");

    const warnCall = mockJobEvents.emitJobEvent.mock.calls.find(([event]) =>
      typeof event?.summary === "string" && event.summary.includes("⚠") && event.summary.includes("critic"),
    );
    expect(warnCall).toBeDefined();
    expect(warnCall![0]).toMatchObject({ jobRunId: "orc_critic", companyId: "co_critic", status: "step" });
    expect(warnCall![0].summary).toContain("escalating");
    expect(warnCall![0].summary).not.toContain("using fallback");
  });

  it("critic: the no-API-key offline case still auto-passes silently", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    setRuntimeEvalOverrides({
      orchestration: {
        createCompletion: async () => {
          throw new Error("OPENAI_API_KEY is not configured");
        },
      },
    });

    const verdict = await critiqueStepOutput(critiqueStep, "some output", {
      companyId: "co_critic_offline",
      runId: "orc_critic_offline",
    });

    expect(verdict).toEqual({ verdict: "pass", reason: "supervisor offline — auto-pass." });
    expect(mockJobEvents.emitJobEvent).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalledWith("orchestrator.llm_failure", expect.anything());
  });
});

// Fix Plan Slice 1 — broad planning objectives must engage specialist seats
import { isBroadPlanningObjective } from "@/lib/orchestrator-runtime";

describe("isBroadPlanningObjective", () => {
  it("detects top-N priority audits (tester regression: ceo+escalation only)", () => {
    expect(isBroadPlanningObjective("Identify the top 5 priorities for the next 7 days across product and growth.")).toBe(true);
  });
  it("detects company/business audits", () => {
    expect(isBroadPlanningObjective("Audit the business and recommend next steps")).toBe(true);
  });
  it("leaves narrow single-domain objectives alone", () => {
    expect(isBroadPlanningObjective("Fix the login button color")).toBe(false);
    expect(isBroadPlanningObjective("Draft a reply to this support ticket")).toBe(false);
  });
});
