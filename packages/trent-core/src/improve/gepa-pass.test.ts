/**
 * I.10 / I.11 — signal filtering before a GEPA pass spends anything: a saturated suite teaches
 * nothing, and a proposal that grew more than 25 percent is length explosion, not learning.
 */
import { describe, expect, it } from "vitest";

import type { TraceRecord } from "../traces/trace-store.js";
import { InMemoryImproveStore } from "./memory-store.js";
import { SEAT_PROMPT_TASK_TYPE, improveStatus, runGepaPass, type FrozenSuite, type GepaPassInput } from "./index.js";

const COMPANY = "co_gepa";
const SUITE: FrozenSuite = {
  id: "s",
  version: "v1",
  fixtures: [{ id: "s:1", prompt: "one", graders: [{ type: "contains", weight: 1, values: ["ok"] }] }],
};

const failing: TraceRecord = {
  id: "t1",
  companyId: COMPANY,
  runId: "run",
  taskType: "ship",
  agentRole: "engineer",
  stepTitle: "x",
  status: "failed",
  toolCalls: [],
  toolCallCount: 0,
  costCents: 1,
  humanCorrected: false,
  skillApplied: false,
  createdAt: "2026-09-12T10:00:00.000Z",
};

function pass(over: Partial<GepaPassInput> & { store: InMemoryImproveStore; calls: { actuals: number; reflect: number } }): GepaPassInput {
  const { calls, ...rest } = over;
  return {
    companyId: COMPANY,
    agentId: "engineer",
    role: "engineer",
    traces: [failing],
    suite: SUITE,
    seatPrompt: async () => "You are the engineer. Ship carefully.",
    baseline: async () => ({ score: 0.5, failureClusters: {} }),
    actuals: async () => {
      calls.actuals += 1;
      return { text: "ok", costCents: 1 };
    },
    reflect: async () => {
      calls.reflect += 1;
      return JSON.stringify({ rationale: "r", proposed_prompt: "You are the engineer. Ship carefully, tested." });
    },
    skipLLM: false,
    now: "2026-09-13T00:00:00.000Z",
    ...rest,
  };
}

describe("runGepaPass signal filtering", () => {
  it("I.10: a baseline of 1.0 skips the pass as suite_saturated with zero actuals and zero reflection calls", async () => {
    const store = new InMemoryImproveStore();
    const calls = { actuals: 0, reflect: 0 };
    const result = await runGepaPass(pass({ store, calls, baseline: async () => ({ score: 1, failureClusters: {} }) }));
    expect(result.skipped).toBe("suite_saturated");
    expect(result.costCents).toBe(0);
    expect(calls).toEqual({ actuals: 0, reflect: 0 });
    const status = await improveStatus(store, COMPANY);
    expect(status.suiteSaturated).toEqual({ engineer: true });
    const [row] = await store.listIterations(COMPANY, { agentId: "engineer", taskType: SEAT_PROMPT_TASK_TYPE });
    expect(row?.blockedBy).toBe("suite_saturated");
  });

  it("I.11: a proposal more than 25 percent longer than the current prompt is rejected before the gate, with zero gate calls", async () => {
    const store = new InMemoryImproveStore();
    const calls = { actuals: 0, reflect: 0 };
    const current = "You are the engineer. Ship carefully.";
    const result = await runGepaPass(
      pass({
        store,
        calls,
        seatPrompt: async () => current,
        reflect: async () => {
          calls.reflect += 1;
          return JSON.stringify({ rationale: "r", proposed_prompt: `${current}\n${current}` });
        },
      }),
    );
    expect(result.skipped).toBe("proposal_too_long");
    expect(calls.actuals).toBe(0);
    expect(calls.reflect).toBe(1);
    // A second sweep over the same failing set does not pay for the reflection again.
    const again = await runGepaPass(pass({ store, calls, seatPrompt: async () => current }));
    expect(again.skipped).toBe("unchanged");
    expect(calls.reflect).toBe(1);
  });

  it("a proposal within the length budget still reaches the gate", async () => {
    const store = new InMemoryImproveStore();
    const calls = { actuals: 0, reflect: 0 };
    const result = await runGepaPass(pass({ store, calls }));
    expect(result.skipped).toBeUndefined();
    expect(result.passed).toBe(true);
    expect(calls.actuals).toBe(1);
  });
});
