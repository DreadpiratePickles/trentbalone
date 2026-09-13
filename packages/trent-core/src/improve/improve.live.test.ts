/**
 * The one live proof: a real sweep over a real trace, with the executing gate running the frozen
 * suite through the real model gateway on gemini-3.5-flash-lite. Three completions for the first
 * sweep (baseline, skill candidate, GEPA proposal); a second sweep over new traces makes TWO,
 * because the baseline is content-addressed (I.3). Before I.3 the pair cost six. No judge, so the
 * free-tier quota is respected; cost per phase is printed from the gateway's real usage.
 *
 * Gated by TRENT_TEST_LIVE=1 (vitest excludes *.live.test.ts otherwise). The key is read from
 * GEMINI_API_KEY or <repo>/gem.env and is never printed.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { createModelGateway } from "../model-gateway/index.js";
import { InMemoryImproveStore } from "./memory-store.js";
import { createGatewayActuals, runImprovementSweep, type FrozenSuite } from "./index.js";

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
    expect(engineer.gepaPasses).toBe(1);
    expect(calls).toBe(3);
    expect(report.phases.baseline.calls).toBe(1);
    expect(report.phases.candidate.calls).toBe(1);
    expect(report.phases.gepa.calls).toBe(1);
    expect(report.phases.judge.calls).toBe(0);
    expect(Number.isInteger(report.costCents)).toBe(true);
    expect(report.costCents).toBe(
      report.phases.baseline.costCents + report.phases.candidate.costCents + report.phases.gepa.costCents + report.phases.judge.costCents,
    );

    const iterations = await store.listIterations(companyId, { agentId: "engineer" });
    expect(iterations.length).toBe(2);
    for (const it of iterations) {
      expect(["pending_approval", "rejected"]).toContain(it.decision);
      expect(it.verdicts).not.toBeNull();
    }
    const frontier = await store.getFrontier(companyId, "engineer");
    expect(frontier?.frontier.best).toBeTruthy();

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
    expect(calls - before).toBe(2);

    console.log(
      `[improve.live] sweep 1: ${JSON.stringify({ costCents: report.costCents, phases: report.phases })}\n` +
        `[improve.live] sweep 2: ${JSON.stringify({ costCents: second.costCents, phases: second.phases })}\n` +
        `[improve.live] gateway calls: sweep 1 = 3, sweep 2 = ${calls - before} (was 3 before I.3); total ${calls} (was 6)`,
    );
  }, 180_000);
});
