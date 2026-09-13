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
      actuals: async ({ systemPrompt }) => {
        gateCalls.push(systemPrompt);
        return { text: "ok", toolCalls: [], costCents: 0 };
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
