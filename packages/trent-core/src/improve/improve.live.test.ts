/**
 * The one live proof: a real sweep over a real trace, with the executing gate running the frozen
 * suite through the real model gateway on gemini-3.5-flash-lite. Three completions in total
 * (baseline, skill candidate, GEPA proposal); no judge, so the free-tier quota is respected.
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

    const iterations = await store.listIterations(companyId, { agentId: "engineer" });
    expect(iterations.length).toBe(2);
    for (const it of iterations) {
      expect(["pending_approval", "rejected"]).toContain(it.decision);
      expect(it.verdicts).not.toBeNull();
    }
    const frontier = await store.getFrontier(companyId, "engineer");
    expect(frontier?.frontier.best).toBeTruthy();
    expect(report.costCents).toBeGreaterThanOrEqual(0);
  }, 120_000);
});
