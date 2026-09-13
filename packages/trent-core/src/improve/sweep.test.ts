/**
 * Item 2 — the sweep on real stores; item 7 — fleet scope.
 * Seeded traces clear the distill threshold; the sweep produces a quarantined draft; a second
 * sweep over the same traces produces nothing new.
 */
import { describe, expect, it } from "vitest";

import type { AgentTraceRow, ImproveStorePort } from "../store/StorePort.js";
import { InMemoryImproveStore } from "./memory-store.js";
import { CORE_SEATS, runImprovementSweep } from "./index.js";

const COMPANY = "co_sweep";

function trace(store: ImproveStorePort, over: Partial<AgentTraceRow> & { id: string; agentId: string }): Promise<void> {
  return store.appendTrace({
    companyId: COMPANY,
    agentRole: "engineer",
    runId: "run_1",
    taskType: "ship-feature",
    stepTitle: "implement",
    status: "completed",
    toolCalls: ["GitHub", "memory:read", "GitHub"],
    toolCallCount: 3,
    critiqueVerdict: "pass",
    improvement: null,
    evalScore: 0.9,
    costCents: 4,
    latencyMs: 100,
    humanCorrected: false,
    skillApplied: false,
    createdAt: "2026-09-12T10:00:00.000Z",
    ...over,
  });
}

async function seedEngineer(store: ImproveStorePort, agentId = "engineer"): Promise<void> {
  await trace(store, { id: `${agentId}_t1`, agentId });
  await trace(store, { id: `${agentId}_t2`, agentId, critiqueVerdict: "retry", improvement: "cite the diff" });
  await trace(store, { id: `${agentId}_t3`, agentId });
}

describe("runImprovementSweep", () => {
  it("distills a quarantined skill draft for a seat whose traces clear the threshold, and logs the iteration", async () => {
    const store = new InMemoryImproveStore();
    await seedEngineer(store);
    const report = await runImprovementSweep(COMPANY, { store, installedAgents: [], skipLLM: true });

    expect(report.agents.map((a) => a.agentId)).toEqual([...CORE_SEATS]);
    const engineer = report.agents.find((a) => a.agentId === "engineer")!;
    expect(engineer.skillsDistilled).toBe(1);
    expect(engineer.traces).toBe(3);

    const drafts = await store.listDrafts(COMPANY, { agentId: "engineer", status: "quarantine" });
    expect(drafts.length).toBe(1);
    expect(drafts[0]?.taskType).toBe("ship-feature");
    expect(drafts[0]?.kind).toBe("skill");
    expect(drafts[0]?.content).toContain("ship-feature");
    expect(drafts[0]?.triggers).toContain("tool_call_threshold");

    const iterations = await store.listIterations(COMPANY, { agentId: "engineer" });
    expect(iterations.length).toBe(1);
    expect(iterations[0]?.candidateId).toBe(drafts[0]?.id);
    expect(iterations[0]?.decision).toBe("quarantined");
    expect(iterations[0]?.blockedBy).toBe("no_suite");
  });

  it("is idempotent: a second sweep over the same traces produces nothing new", async () => {
    const store = new InMemoryImproveStore();
    await seedEngineer(store);
    await runImprovementSweep(COMPANY, { store, installedAgents: [], skipLLM: true });
    const second = await runImprovementSweep(COMPANY, { store, installedAgents: [], skipLLM: true });

    const engineer = second.agents.find((a) => a.agentId === "engineer")!;
    expect(engineer.skillsDistilled).toBe(0);
    expect(engineer.skipped).toContain("ship-feature: unchanged");
    expect((await store.listDrafts(COMPANY, { agentId: "engineer" })).length).toBe(1);
    expect((await store.listIterations(COMPANY, { agentId: "engineer" })).length).toBe(1);
  });

  it("a seat with no traces sweeps to no_candidate without touching the stores", async () => {
    const store = new InMemoryImproveStore();
    const report = await runImprovementSweep(COMPANY, { store, installedAgents: [], skipLLM: true });
    for (const agent of report.agents) {
      expect(agent.traces).toBe(0);
      expect(agent.skillsDistilled).toBe(0);
    }
    expect(await store.listDrafts(COMPANY)).toEqual([]);
    expect(await store.listIterations(COMPANY)).toEqual([]);
  });

  it("persists one GEPA frontier per AGENT with the seat's real prompt, evolved from failing traces through the executing gate", async () => {
    const store = new InMemoryImproveStore();
    await seedEngineer(store);
    await seedEngineer(store, "eng-ai-engineer");
    const prompts: Record<string, string> = { engineer: "SEAT PROMPT engineer", "eng-ai-engineer": "SEAT PROMPT specialist" };
    const gateCalls: string[] = [];
    const report = await runImprovementSweep(COMPANY, {
      store,
      installedAgents: ["eng-ai-engineer"],
      skipLLM: true,
      seatPrompt: async (agentId) => prompts[agentId] ?? "",
      suiteFor: () => ({
        id: "suite",
        version: "v1",
        fixtures: [{ id: "f1", prompt: "say ok", graders: [{ type: "contains", weight: 1, values: ["ok"] }] }],
      }),
      // The bare seat prompt fails the fixture, so the suite is not saturated (I.10) and every candidate flips it.
      actuals: async ({ systemPrompt }) => {
        gateCalls.push(systemPrompt);
        return { text: systemPrompt.includes("gepa evolved") || systemPrompt.includes("Company skill") ? "ok" : "nope", toolCalls: [], costCents: 0 };
      },
    });

    const engineer = report.agents.find((a) => a.agentId === "engineer")!;
    const specialist = report.agents.find((a) => a.agentId === "eng-ai-engineer")!;
    expect(engineer.gepaPasses).toBe(1);
    expect(specialist.gepaPasses).toBe(1);

    const f1 = await store.getFrontier(COMPANY, "engineer");
    const f2 = await store.getFrontier(COMPANY, "eng-ai-engineer");
    expect(f1?.frontier.best).toBeTruthy();
    expect(f2?.frontier.best).toBeTruthy();
    expect(JSON.stringify(f1?.frontier)).toContain("SEAT PROMPT engineer");
    expect(JSON.stringify(f2?.frontier)).toContain("SEAT PROMPT specialist");
    // The gate executed the candidate: the proposal (seat prompt + GEPA edit) reached the model.
    expect(gateCalls.some((p) => p.startsWith("SEAT PROMPT engineer") && p.includes("gepa evolved"))).toBe(true);
    // A passing prompt proposal is staged as a quarantined prompt draft, never written live.
    const staged = await store.listDrafts(COMPANY, { agentId: "engineer", kind: "prompt" });
    expect(staged.map((d) => d.status)).toEqual(["quarantine"]);
  });
});

/** A suite of N fixtures, each with one mechanical grader and one rubric, so a judge has work. */
function suiteOf(n: number, version = "v1") {
  return {
    id: "cost",
    version,
    fixtures: Array.from({ length: n }, (_, i) => ({
      id: `f${i + 1}`,
      prompt: `say ok ${i + 1}`,
      graders: [
        { type: "contains" as const, weight: 1, values: ["ok"] },
        { type: "llm_rubric" as const, weight: 1, rubric: "Is polite." },
      ],
    })),
  };
}

/**
 * One-cent-per-call model access, with every call counted by the system prompt it saw. The bare
 * seat prompt is "ok, whatever" on fixture 1 and the judge fails that, so the baseline is below
 * 1.0 (a saturated suite skips GEPA, I.10) and each candidate flips exactly one fixture, which
 * the gate re-draws once (I.12): a candidate phase is N + 1 executor calls for N fixtures.
 */
function centGateway(reply = "ok") {
  const calls: string[] = [];
  let judgeCalls = 0;
  return {
    calls,
    judge: async ({ actual }: { actual: { text: string } }) => {
      judgeCalls += 1;
      return { pass: !actual.text.includes("whatever"), costCents: 1 };
    },
    judgeCalls: () => judgeCalls,
    actuals: async ({ systemPrompt, fixtureId }: { systemPrompt: string; fixtureId: string }) => {
      calls.push(systemPrompt);
      const bare = !systemPrompt.includes("gepa evolved") && !systemPrompt.includes("Company skill");
      return { text: bare && fixtureId === "f1" ? `${reply}, whatever` : reply, toolCalls: [], costCents: 1 };
    },
  };
}

describe("cost accounting and budget (I.1-I.3)", () => {
  const SEAT = "SEAT PROMPT engineer";

  it("I.1: with a gateway whose every call costs 1 cent, report.costCents equals the total number of calls, per phase", async () => {
    const store = new InMemoryImproveStore();
    await seedEngineer(store);
    const gw = centGateway();
    const report = await runImprovementSweep(COMPANY, {
      store,
      installedAgents: [],
      skipLLM: true,
      agentFilter: "engineer",
      seatPrompt: async () => SEAT,
      suiteFor: () => suiteOf(3),
      actuals: gw.actuals,
      judge: gw.judge,
    });
    const total = gw.calls.length + gw.judgeCalls();
    expect(total).toBeGreaterThan(0);
    expect(report.costCents).toBe(total);
    // Where the calls went: baseline, the skill candidate, the GEPA proposal (each 3 fixtures + 1 re-draw), and the judge across all three.
    expect(report.phases.baseline.calls).toBe(3);
    expect(report.phases.candidate.calls).toBe(4);
    expect(report.phases.gepa.calls).toBe(4);
    expect(report.phases.judge.calls).toBe(gw.judgeCalls());
    expect(report.phases.baseline.costCents + report.phases.candidate.costCents + report.phases.gepa.costCents + report.phases.judge.costCents).toBe(total);
    expect(Number.isInteger(report.costCents)).toBe(true);
  });

  it("I.2: budgetCents stops the sweep at the budget and marks what could not be measured budget_exhausted", async () => {
    const store = new InMemoryImproveStore();
    await seedEngineer(store);
    const gw = centGateway();
    const report = await runImprovementSweep(COMPANY, {
      store,
      installedAgents: [],
      skipLLM: true,
      agentFilter: "engineer",
      seatPrompt: async () => SEAT,
      suiteFor: () => suiteOf(6),
      actuals: gw.actuals,
      judge: gw.judge,
      budgetCents: 10,
    });
    expect(report.costCents).toBeLessThanOrEqual(10);
    expect(gw.calls.length + gw.judgeCalls()).toBeLessThanOrEqual(10);
    expect(report.budget).toEqual({ limitCents: 10, exhausted: true });
    const engineer = report.agents.find((a) => a.agentId === "engineer")!;
    expect(engineer.errors).toEqual([]);
    const iterations = await store.listIterations(COMPANY, { agentId: "engineer" });
    const skill = iterations.find((i) => i.candidateKind === "skill")!;
    expect(skill.decision).toBe("quarantined");
    expect(skill.blockedBy).toBe("budget_exhausted");
    // An unmeasured draft is not rejected: it waits in quarantine for a sweep with budget.
    expect((await store.getDraft(skill.candidateId!))?.status).toBe("quarantine");
    expect(engineer.skipped).toContain("gepa: budget_exhausted");
  });

  it("I.3: a second sweep with the same seat prompt and suite version makes zero baseline calls", async () => {
    const store = new InMemoryImproveStore();
    await seedEngineer(store);
    const gw = centGateway();
    const deps = {
      store,
      installedAgents: [],
      skipLLM: true,
      agentFilter: "engineer",
      seatPrompt: async () => SEAT,
      suiteFor: () => suiteOf(2),
      actuals: gw.actuals,
      judge: gw.judge,
    };
    const first = await runImprovementSweep(COMPANY, deps);
    expect(first.phases.baseline.calls).toBe(2);
    expect(gw.calls.filter((p) => p === SEAT).length).toBe(2);

    // New traces, so the second sweep must gate a fresh draft and has a real reason to want the baseline.
    await trace(store, { id: "engineer_t4", agentId: "engineer", createdAt: "2026-09-12T11:00:00.000Z" });
    gw.calls.length = 0;
    const second = await runImprovementSweep(COMPANY, deps);
    const engineer = second.agents.find((a) => a.agentId === "engineer")!;
    expect(engineer.skillsDistilled).toBe(1);
    expect(second.phases.candidate.calls).toBe(2 + 1);
    expect(gw.calls.filter((p) => p === SEAT).length).toBe(0);
    expect(second.phases.baseline.calls).toBe(0);
  });
});

describe("fleet scope", () => {
  it("an uninstalled specialist never appears in a sweep report; installing it and giving it traces does", async () => {
    const store = new InMemoryImproveStore();
    await seedEngineer(store, "eng-ai-engineer");

    const before = await runImprovementSweep(COMPANY, { store, installedAgents: [], skipLLM: true });
    expect(before.agents.map((a) => a.agentId)).not.toContain("eng-ai-engineer");
    expect(before.skippedSpecialists).toEqual([]);

    const after = await runImprovementSweep(COMPANY, { store, installedAgents: ["eng-ai-engineer"], skipLLM: true });
    const specialist = after.agents.find((a) => a.agentId === "eng-ai-engineer");
    expect(specialist?.skillsDistilled).toBe(1);
  });

  it("an installed specialist below the distill threshold of traces is listed as skipped, not swept", async () => {
    const store = new InMemoryImproveStore();
    await trace(store, { id: "one", agentId: "spec-thin" });
    const report = await runImprovementSweep(COMPANY, { store, installedAgents: ["spec-thin"], skipLLM: true, distillThreshold: 3 });
    expect(report.agents.map((a) => a.agentId)).not.toContain("spec-thin");
    expect(report.skippedSpecialists).toEqual([{ agentId: "spec-thin", reason: "below_threshold", traces: 1, threshold: 3 }]);
  });

  it("--agent narrows the sweep to one seat", async () => {
    const store = new InMemoryImproveStore();
    await seedEngineer(store);
    const report = await runImprovementSweep(COMPANY, { store, installedAgents: [], skipLLM: true, agentFilter: "engineer" });
    expect(report.agents.map((a) => a.agentId)).toEqual(["engineer"]);
  });
});
