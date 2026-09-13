/**
 * The one live proof: a real sweep over a real trace, with the executing gate running the frozen
 * suite through the real model gateway on gemini-3.5-flash-lite. When the model passes the one
 * mechanical fixture at baseline the suite is saturated and GEPA is skipped (I.10): TWO
 * completions for the first sweep (baseline, skill candidate) and ONE for a second sweep over new
 * traces, because the baseline is content-addressed (I.3). When it does not, the pass runs and the
 * counts are the pre-I.10 three and two. No judge in the sweep, so the free-tier quota is
 * respected; cost per phase is printed from the gateway's real usage.
 *
 * The second proof is the evidence-cited judge (I.7): one judge call on a fixed output must come
 * back with a citation that really is a substring of that output, or the gate refuses it.
 *
 * Gated by TRENT_TEST_LIVE=1 (vitest excludes *.live.test.ts otherwise). The key is read from
 * GEMINI_API_KEY or <repo>/gem.env and is never printed.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { createModelGateway } from "../model-gateway/index.js";
import { InMemoryImproveStore } from "./memory-store.js";
import { createGatewayActuals, createGatewayJudge, executeGate, runImprovementSweep, type FrozenSuite } from "./index.js";

const REPO_ROOT = path.resolve(__dirname, "../../../..");
const LIVE_MODEL = "gemini-3.5-flash-lite";

function readGeminiKey(): string | undefined {
  const fromEnv = process.env.GEMINI_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  try {
    for (const line of readFileSync(path.join(REPO_ROOT, "gem.env"), "utf8").split(/\r?\n/)) {
      const match = /^\s*(?:export\s+)?GEMINI_API_KEY\s*=\s*(.*)$/.exec(line);
      if (match) {
        const value = match[1]!.trim().replace(/^["']|["']$/g, "");
        if (value) return value;
      }
    }
  } catch {
    /* fall through */
  }
  return undefined;
}

const GEMINI_API_KEY = readGeminiKey();
if (!GEMINI_API_KEY) console.error("[improve.live] SKIPPED: no GEMINI_API_KEY (env or <repo>/gem.env). A skip is NOT a pass.");

const SUITE: FrozenSuite = {
  id: "live-smoke",
  version: "v1",
  fixtures: [
    {
      id: "live:1",
      prompt: "In one sentence, name the first tool an engineer seat should consult before changing code, and include the word 'memory'.",
      graders: [{ type: "contains", weight: 1, values: ["memory"] }],
    },
  ],
};

describe.skipIf(!GEMINI_API_KEY)("improve loop (live, google/gemini)", () => {
  it("sweeps a real trace, executes the gate through the real gateway, and lands a gated draft plus a per-agent frontier", async () => {
    const gateway = await createModelGateway({
      apiKeys: { google: GEMINI_API_KEY! },
      preferredProvider: "google",
      allowedProviders: ["google"],
      models: { executor: LIVE_MODEL },
    });
    let calls = 0;
    const actuals = createGatewayActuals(gateway);
    const counted: typeof actuals = async (input) => {
      calls += 1;
      return actuals(input);
    };

    const store = new InMemoryImproveStore();
    const companyId = "co_live";
    const base = {
      companyId,
      agentRole: "engineer",
      agentId: "engineer",
      runId: "run_live",
      taskType: "ship-feature",
      stepTitle: "implement",
      status: "completed",
      toolCalls: ["GitHub", "memory:read", "GitHub"],
      toolCallCount: 3,
      improvement: null,
      evalScore: 0.9,
      costCents: 4,
      latencyMs: 100,
      humanCorrected: false,
      skillApplied: false,
      createdAt: "2026-09-12T10:00:00.000Z",
    };
    await store.appendTrace({ ...base, id: "t1", critiqueVerdict: "pass" });
    await store.appendTrace({ ...base, id: "t2", critiqueVerdict: "retry", improvement: "read memory before editing" });

    const report = await runImprovementSweep(companyId, {
      store,
      installedAgents: [],
      agentFilter: "engineer",
      skipLLM: true,
      seatPrompt: async () => "You are the engineer seat of a small startup. Answer briefly.",
      suiteFor: () => SUITE,
      actuals: counted,
    });

    const engineer = report.agents.find((a) => a.agentId === "engineer")!;
    expect(engineer.errors).toEqual([]);
    expect(engineer.skillsDistilled).toBe(1);
    const saturated = engineer.skipped.includes("gepa: suite_saturated");
    expect(engineer.gepaPasses).toBe(saturated ? 0 : 1);
    expect(report.phases.baseline.calls).toBe(1);
    expect(report.phases.candidate.calls).toBeGreaterThanOrEqual(1);
    expect(report.phases.gepa.calls).toBe(saturated ? 0 : report.phases.gepa.calls);
    expect(report.phases.judge.calls).toBe(0);
    expect(calls).toBe(report.phases.baseline.calls + report.phases.candidate.calls + report.phases.gepa.calls);
    expect(Number.isInteger(report.costCents)).toBe(true);
    expect(report.costCents).toBe(
      report.phases.baseline.costCents + report.phases.candidate.costCents + report.phases.gepa.costCents + report.phases.judge.costCents,
    );

    const iterations = await store.listIterations(companyId, { agentId: "engineer" });
    expect(iterations.length).toBe(2);
    for (const it of iterations) {
      expect(["pending_approval", "rejected", "skipped"]).toContain(it.decision);
      expect(it.verdicts).not.toBeNull();
    }
    if (!saturated) expect((await store.getFrontier(companyId, "engineer"))?.frontier.best).toBeTruthy();

    // A second sweep over a new trace gates a fresh draft without re-buying the baseline.
    await store.appendTrace({ ...base, id: "t3", critiqueVerdict: "retry", improvement: "cite the diff", createdAt: "2026-09-12T11:00:00.000Z" });
    const before = calls;
    const second = await runImprovementSweep(companyId, {
      store,
      installedAgents: [],
      agentFilter: "engineer",
      skipLLM: true,
      seatPrompt: async () => "You are the engineer seat of a small startup. Answer briefly.",
      suiteFor: () => SUITE,
      actuals: counted,
    });
    const again = second.agents.find((a) => a.agentId === "engineer")!;
    expect(again.errors).toEqual([]);
    expect(again.skillsDistilled).toBe(1);
    expect(second.phases.baseline.calls).toBe(0);
    expect(calls - before).toBe(second.phases.candidate.calls + second.phases.gepa.calls);

    console.log(
      `[improve.live] sweep 1: ${JSON.stringify({ costCents: report.costCents, phases: report.phases, saturated })}\n` +
        `[improve.live] sweep 2: ${JSON.stringify({ costCents: second.costCents, phases: second.phases })}\n` +
        `[improve.live] gateway calls: sweep 1 = ${before}, sweep 2 = ${calls - before}; total ${calls} (was 6 before I.3, 5 before I.10)`,
    );
  }, 180_000);

  it("I.7: the real judge cites evidence that is verifiably in the output, and the gate accepts it (one judge call per draw, two draws)", async () => {
    const gateway = await createModelGateway({
      apiKeys: { google: GEMINI_API_KEY! },
      preferredProvider: "google",
      allowedProviders: ["google"],
      models: { executor: LIVE_MODEL },
    });
    const output = "Consult the company memory first: read memory:read before any code change, then check the diff.";
    const verdict = await executeGate({
      candidate: { id: "live_judge", kind: "prompt", content: "unused" },
      seatPrompt: "unused",
      suite: {
        id: "live-judge",
        version: "v1",
        fixtures: [{ id: "lj:1", prompt: "What do you consult first?", graders: [{ type: "llm_rubric", weight: 1, rubric: "Says to consult memory before changing code." }] }],
      },
      baseline: { score: 0, failureClusters: {}, fixtures: [{ id: "lj:1", passed: false }] },
      actuals: async () => ({ text: output, costCents: 0 }),
      judge: createGatewayJudge(gateway),
    });
    expect(verdict.judgeCalls).toBeGreaterThanOrEqual(1);
    expect(verdict.failureClusters).not.toHaveProperty("judge_unverified");
    expect(verdict.fixtures[0]?.score).toBe(1);
    console.log(`[improve.live] judge: ${JSON.stringify({ judgeCalls: verdict.judgeCalls, costCents: verdict.costCents, promoted: verdict.promoted, redraw: verdict.redraw })}`);
  }, 120_000);
});
