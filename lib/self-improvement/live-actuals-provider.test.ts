import { describe, it, expect, vi } from "vitest";
import {
  LiveActualsProvider,
  type LiveRunRequest,
  type LiveRunResult,
  type OrchestratorRunner,
} from "@/lib/self-improvement/live-actuals-provider";

const COMPANY = "co_live";
const OVERLAY = { taskType: "ads", skillContent: "# ads\nAlways state a budget.", candidateId: "qdraft_1" };

const FIXTURES = [
  { id: "ads:1", input: "Plan a paid ads budget for a B2B SaaS" },
  { id: "ads:2", input: "Plan a retargeting budget" },
  { id: "ads:3", input: "Plan an awareness budget" },
];

/** A runner that echoes the input and reports a fixed cost. */
function echoRunner(costCents = 10): OrchestratorRunner {
  return async (req: LiveRunRequest): Promise<LiveRunResult> => ({
    actual: { text: `Recommend a budget for: ${String(req.input)}`, toolCalls: ["estimate"] },
    costCents,
  });
}

describe("LiveActualsProvider — live candidate execution (Slice 2)", () => {
  it("primes each fixture via the injected runner and serves results synchronously through get()", async () => {
    const runner = vi.fn(echoRunner(7));
    const provider = new LiveActualsProvider({
      companyId: COMPANY,
      overlay: OVERLAY,
      runner,
      budgetCentsPerRun: 50,
      totalBudgetCents: 1000,
    });

    const report = await provider.prime(FIXTURES);

    expect(report.killed).toBe(false);
    expect(report.primed).toBe(3);
    expect(report.skipped).toBe(0);
    expect(report.spentCents).toBe(21); // 3 runs × 7
    expect(report.errors).toEqual([]);

    // The ActualsProvider seam: get() is synchronous and reads the primed cache.
    expect(provider.get("ads:1")?.text).toContain("Plan a paid ads budget");
    expect(provider.get("ads:1")?.toolCalls).toEqual(["estimate"]);
    expect(provider.get("missing")).toBeUndefined();

    // The runner received the candidate overlay + fixture input + per-run budget.
    expect(runner).toHaveBeenCalledTimes(3);
    const firstCall = runner.mock.calls[0][0] as LiveRunRequest;
    expect(firstCall.companyId).toBe(COMPANY);
    expect(firstCall.overlay.skillContent).toBe(OVERLAY.skillContent);
    expect(firstCall.budgetCents).toBe(50);
    expect(firstCall.fixtureId).toBe("ads:1");
  });

  it("stops at the total budget cap without overspending", async () => {
    const runner = vi.fn(echoRunner(10));
    const provider = new LiveActualsProvider({
      companyId: COMPANY,
      overlay: OVERLAY,
      runner,
      budgetCentsPerRun: 10,
      totalBudgetCents: 25, // affords only 2 runs (third would reach 30 > 25)
    });

    const report = await provider.prime(FIXTURES);

    expect(report.primed).toBe(2);
    expect(report.skipped).toBe(1);
    expect(report.spentCents).toBe(20);
    expect(runner).toHaveBeenCalledTimes(2);
    expect(provider.get("ads:1")).toBeDefined();
    expect(provider.get("ads:3")).toBeUndefined();
  });

  it("honors the kill switch: no runs, no spend, nothing cached", async () => {
    const runner = vi.fn(echoRunner(10));
    const provider = new LiveActualsProvider({
      companyId: COMPANY,
      overlay: OVERLAY,
      runner,
      budgetCentsPerRun: 10,
      totalBudgetCents: 1000,
      killSwitch: () => true,
    });

    const report = await provider.prime(FIXTURES);

    expect(report.killed).toBe(true);
    expect(report.primed).toBe(0);
    expect(report.skipped).toBe(3);
    expect(report.spentCents).toBe(0);
    expect(runner).not.toHaveBeenCalled();
    expect(provider.get("ads:1")).toBeUndefined();
  });

  it("records a single run failure and continues priming the rest", async () => {
    const runner = vi.fn(async (req: LiveRunRequest): Promise<LiveRunResult> => {
      if (req.fixtureId === "ads:2") throw new Error("orchestrator boom");
      return { actual: { text: `ok ${req.fixtureId}` }, costCents: 5 };
    });
    const provider = new LiveActualsProvider({
      companyId: COMPANY,
      overlay: OVERLAY,
      runner,
      budgetCentsPerRun: 50,
      totalBudgetCents: 1000,
    });

    const report = await provider.prime(FIXTURES);

    expect(report.primed).toBe(2);
    expect(report.skipped).toBe(1);
    expect(report.errors.some((e) => e.includes("ads:2"))).toBe(true);
    expect(provider.get("ads:1")).toBeDefined();
    expect(provider.get("ads:2")).toBeUndefined();
    expect(provider.get("ads:3")).toBeDefined();
  });

  it("stops priming when the company spend guard denies (cap reached)", async () => {
    const runner = vi.fn(echoRunner(10));
    let calls = 0;
    const budgetGuard = vi.fn(async () => {
      calls += 1;
      if (calls >= 2) throw new Error("would exceed the company monthly spend cap");
    });
    const provider = new LiveActualsProvider({
      companyId: COMPANY,
      overlay: OVERLAY,
      runner,
      budgetCentsPerRun: 10,
      totalBudgetCents: 1000,
      budgetGuard,
    });

    const report = await provider.prime(FIXTURES);

    expect(report.primed).toBe(1); // first run cleared the guard; second denied → stop
    expect(report.errors.length).toBeGreaterThanOrEqual(1);
    expect(runner).toHaveBeenCalledTimes(1);
    expect(provider.get("ads:1")).toBeDefined();
    expect(provider.get("ads:3")).toBeUndefined();
  });
});
