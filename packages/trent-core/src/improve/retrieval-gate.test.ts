/**
 * [W3] The recall gate: the audit's failing test (harness upgrade audit, section 4 item 3).
 *
 * A suite of five queries over a fixture brain scores recall@8 = 1.0 with the shipped ranker, and
 * a ranker patched, through the evaluator's seam, to return the reverse order fails the gate with
 * the metric named. The grader is deterministic and runs FIRST: a floor breach costs no model
 * call. The ranking surface is frozen, so no draft can edit its way past the floor.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createBrain, type Brain, type BrainExec } from "../fleet-memory/brain.js";
import { brainRanker, evaluateRetrieval, type RankedChunk, type RetrievalRanker } from "../fleet-memory/retrieval-eval.js";
import { RETRIEVAL_FIXTURE_QUERIES, importRetrievalFixture } from "../fleet-memory/retrieval-fixture.js";
import { DEFAULT_MEMORY_BLOCKS } from "../tools/memory/blocks.js";
import { RETRIEVAL_GATE_DEFAULTS, RetrievalGateConfigSchema } from "./retrieval-config-schema.js";
import { RANKING_SURFACE_PATHS, createFrozenSurface } from "./frozen-surface.js";
import type { AgentTraceRow } from "../store/StorePort.js";
import { InMemoryImproveStore } from "./memory-store.js";
import { executeGate, runImprovementSweep, type ActualsRunner, type FrozenSuite } from "./index.js";
import { DEFAULT_RETRIEVAL_MIN_RECALL, RETRIEVAL_RECALL_METRIC, gradeRetrievalRecall, retrievalFailureTag } from "./retrieval-gate.js";

let profileDir: string;
let sourceDir: string;
const noGit: BrainExec = () => ({ code: 127, stdout: "", stderr: "git: command not found" });

beforeEach(() => {
  profileDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "trent-retrieval-gate-")));
  sourceDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "trent-retrieval-gate-src-")));
});

afterEach(() => {
  fs.rmSync(profileDir, { recursive: true, force: true });
  fs.rmSync(sourceDir, { recursive: true, force: true });
});

async function fixtureBrain(): Promise<Brain> {
  const brain = createBrain({ profileDir, exec: noGit });
  brain.ensure();
  await importRetrievalFixture(brain, sourceDir);
  return brain;
}

const SUITE: FrozenSuite = {
  id: "ops",
  version: "v1",
  fixtures: [{ id: "ops:1", prompt: "Which tool do you call first?", graders: [{ type: "tool_call", weight: 1, required: ["memory:read"] }] }],
};

function countedActuals(): { actuals: ActualsRunner; calls: () => number } {
  let n = 0;
  return {
    actuals: async () => {
      n += 1;
      return { text: "memory first", toolCalls: ["memory:read"], costCents: 1 };
    },
    calls: () => n,
  };
}

const reversedOf =
  (shipped: RetrievalRanker): RetrievalRanker =>
  async (query, seat) =>
    [...(await shipped(query, seat))].reverse() as RankedChunk[];

describe("[W3] the retrieval_recall grader", () => {
  it("passes at the floor with the shipped ranker and names the metric, the floor and k", async () => {
    const brain = await fixtureBrain();
    const report = await gradeRetrievalRecall({ evaluate: () => evaluateRetrieval(brain, RETRIEVAL_FIXTURE_QUERIES) });
    expect(report).toMatchObject({ metric: RETRIEVAL_RECALL_METRIC, measured: true, passed: true, recallAtK: 1, k: 8, queries: 5, hits: 5, minRecall: DEFAULT_RETRIEVAL_MIN_RECALL, misses: [] });
    expect(DEFAULT_RETRIEVAL_MIN_RECALL).toBe(0.9);
  });

  it("fails below the floor with the misses named, and the failure tag carries the number", async () => {
    const brain = await fixtureBrain();
    const reversed = reversedOf(brainRanker({ brain }));
    const report = await gradeRetrievalRecall({ evaluate: () => evaluateRetrieval(brain, RETRIEVAL_FIXTURE_QUERIES, { rank: reversed }) });
    expect(report.passed).toBe(false);
    expect(report.recallAtK).toBeLessThan(0.9);
    expect(report.misses.map((m) => m.id)).toContain("rgold_fixture_lease");
    expect(retrievalFailureTag(report)).toBe(`${RETRIEVAL_RECALL_METRIC}:${String(report.recallAtK)}<${String(report.minRecall)}`);
  });

  it("a lower configured floor lets the same number through, and no goldens is not a pass", async () => {
    const brain = await fixtureBrain();
    const reversed = reversedOf(brainRanker({ brain }));
    const lenient = await gradeRetrievalRecall({ evaluate: () => evaluateRetrieval(brain, RETRIEVAL_FIXTURE_QUERIES, { rank: reversed }), minRecall: 0.5 });
    expect(lenient.passed).toBe(true);
    const empty = await gradeRetrievalRecall({ evaluate: () => evaluateRetrieval(brain, []) });
    expect(empty).toMatchObject({ measured: false, passed: false, queries: 0 });
  });
});

describe("[W3] executeGate holds a candidate to the recall floor before any model call", () => {
  it("recall@8 = 1.0 with the shipped ranker: the gate goes on to run the suite and can promote", async () => {
    const brain = await fixtureBrain();
    const { actuals, calls } = countedActuals();
    const verdict = await executeGate({
      candidate: { id: "draft_ok", kind: "skill", content: "# a skill" },
      seatPrompt: "seat",
      suite: SUITE,
      baseline: { score: 1, failureClusters: {} },
      actuals,
      retrieval: { evaluate: () => evaluateRetrieval(brain, RETRIEVAL_FIXTURE_QUERIES) },
    });
    expect(verdict.promoted).toBe(true);
    expect(verdict.retrieval).toMatchObject({ passed: true, recallAtK: 1, minRecall: 0.9 });
    expect(calls()).toBeGreaterThan(0);
  });

  it("a ranker patched to return reversed order fails the gate with the metric named, and costs no model call", async () => {
    const brain = await fixtureBrain();
    const { actuals, calls } = countedActuals();
    const reversed = reversedOf(brainRanker({ brain }));
    const verdict = await executeGate({
      candidate: { id: "draft_reversed", kind: "skill", content: "# a skill" },
      seatPrompt: "seat",
      suite: SUITE,
      baseline: { score: 1, failureClusters: {} },
      actuals,
      retrieval: { evaluate: () => evaluateRetrieval(brain, RETRIEVAL_FIXTURE_QUERIES, { rank: reversed }) },
    });
    expect(verdict.promoted).toBe(false);
    expect(verdict.blockedBy).toBe("retrieval_recall");
    expect(verdict.stage).toBe("deterministic");
    expect(Object.keys(verdict.failureClusters)).toEqual([RETRIEVAL_RECALL_METRIC]);
    expect(verdict.retrieval?.passed).toBe(false);
    expect(verdict.retrieval?.recallAtK).toBeLessThan(0.9);
    expect(verdict.retrieval?.misses.map((m) => m.id)).toContain("rgold_fixture_lease");
    expect(verdict.actualsCalls).toBe(0);
    expect(verdict.judgeCalls).toBe(0);
    expect(verdict.costCents).toBe(0);
    expect(calls()).toBe(0);
  });
});

describe("[W3] the sweep holds every gated draft to the floor", () => {
  async function seed(store: InMemoryImproveStore): Promise<void> {
    const base: Omit<AgentTraceRow, "id" | "critiqueVerdict" | "improvement"> = {
      companyId: "co_w3",
      agentRole: "engineer",
      agentId: "engineer",
      runId: "run_1",
      taskType: "ship-feature",
      stepTitle: "implement",
      status: "completed",
      toolCalls: ["GitHub", "memory:read", "GitHub"],
      toolCallCount: 3,
      evalScore: 0.9,
      costCents: 4,
      latencyMs: 100,
      humanCorrected: false,
      skillApplied: false,
      createdAt: "2026-09-12T10:00:00.000Z",
    };
    await store.appendTrace({ ...base, id: "t1", critiqueVerdict: "pass", improvement: null });
    await store.appendTrace({ ...base, id: "t2", critiqueVerdict: "retry", improvement: "cite the diff" });
    await store.appendTrace({ ...base, id: "t3", critiqueVerdict: "pass", improvement: null });
  }

  it("a breach leaves the draft quarantined as retrieval_recall, with the report on the iteration and no candidate call", async () => {
    const brain = await fixtureBrain();
    const store = new InMemoryImproveStore();
    await seed(store);
    const reversed = reversedOf(brainRanker({ brain }));
    let candidateCalls = 0;
    const report = await runImprovementSweep("co_w3", {
      store,
      installedAgents: [],
      skipLLM: true,
      agentFilter: "engineer",
      seatPrompt: async () => "SEAT",
      suiteFor: () => SUITE,
      actuals: async ({ systemPrompt }) => {
        if (systemPrompt.includes("Company skill")) candidateCalls += 1;
        return { text: "memory first", toolCalls: ["memory:read"], costCents: 1 };
      },
      retrieval: { evaluate: () => evaluateRetrieval(brain, RETRIEVAL_FIXTURE_QUERIES, { rank: reversed }) },
    });
    const engineer = report.agents.find((a) => a.agentId === "engineer")!;
    expect(engineer.skillsDistilled).toBe(1);
    expect(engineer.skillsRejected).toBe(0);
    expect(candidateCalls).toBe(0);
    const iteration = (await store.listIterations("co_w3", { agentId: "engineer", taskType: "ship-feature" }))[0]!;
    expect(iteration.decision).toBe("quarantined");
    expect(iteration.blockedBy).toBe("retrieval_recall");
    const verdict = iteration.verdicts as { retrieval?: { recallAtK: number; minRecall: number; misses: Array<{ id: string }> } };
    expect(verdict.retrieval?.minRecall).toBe(0.9);
    expect(verdict.retrieval?.recallAtK).toBeLessThan(0.9);
    expect(verdict.retrieval?.misses.map((m) => m.id)).toContain("rgold_fixture_lease");
    expect((await store.listDrafts("co_w3", { agentId: "engineer", status: "quarantine" })).length).toBe(1);
  });

  it("at the floor the same sweep gates the draft on its suite as before", async () => {
    const brain = await fixtureBrain();
    const store = new InMemoryImproveStore();
    await seed(store);
    const report = await runImprovementSweep("co_w3", {
      store,
      installedAgents: [],
      skipLLM: true,
      agentFilter: "engineer",
      seatPrompt: async () => "SEAT",
      suiteFor: () => SUITE,
      actuals: async () => ({ text: "memory first", toolCalls: ["memory:read"], costCents: 1 }),
      retrieval: { evaluate: () => evaluateRetrieval(brain, RETRIEVAL_FIXTURE_QUERIES) },
    });
    const engineer = report.agents.find((a) => a.agentId === "engineer")!;
    expect(engineer.skillsGated).toBe(1);
    const iteration = (await store.listIterations("co_w3", { agentId: "engineer", taskType: "ship-feature" }))[0]!;
    expect(iteration.decision).toBe("pending_approval");
    expect((iteration.verdicts as { retrieval?: { passed: boolean } }).retrieval?.passed).toBe(true);
  });
});

describe("[W3] the ranking surface is frozen", () => {
  it("refuses a draft's write to recall, the blend, the index or the ingest pipeline, in src and dist", () => {
    const surface = createFrozenSurface({ profileDir, blocks: DEFAULT_MEMORY_BLOCKS });
    expect(RANKING_SURFACE_PATHS.length).toBeGreaterThanOrEqual(4);
    for (const frozen of RANKING_SURFACE_PATHS) {
      const target = frozen.endsWith("ingest") ? path.join(frozen, "chunk.ts") : frozen;
      expect(surface.violationFor({ path: target })?.frozenClass, target).toBe("ranking");
    }
    const src = RANKING_SURFACE_PATHS.filter((p) => p.includes(`${path.sep}src${path.sep}`));
    const dist = RANKING_SURFACE_PATHS.filter((p) => p.includes(`${path.sep}dist${path.sep}`));
    expect(src.length).toBeGreaterThanOrEqual(4);
    expect(src.length === dist.length || dist.length === 0).toBe(true);
    // The search adapter beside them is not the ranker and stays writable by this rule.
    const search = path.join(path.dirname(src[0]!), "search.ts");
    expect(surface.violationFor({ path: search })?.frozenClass).not.toBe("ranking");
  });
});

describe("[W3] the retrieval gate config", () => {
  it("defaults min_recall to 0.9, bounds it to [0,1], and refuses an unknown key", () => {
    expect(RetrievalGateConfigSchema.parse({})).toEqual(RETRIEVAL_GATE_DEFAULTS);
    expect(RETRIEVAL_GATE_DEFAULTS.min_recall).toBe(0.9);
    expect(RetrievalGateConfigSchema.parse({ min_recall: 0.5 }).min_recall).toBe(0.5);
    expect(RetrievalGateConfigSchema.safeParse({ min_recall: 1.5 }).success).toBe(false);
    expect(RetrievalGateConfigSchema.safeParse({ min_recall: -0.1 }).success).toBe(false);
    expect(RetrievalGateConfigSchema.safeParse({ floor: 0.9 }).success).toBe(false);
  });
});
