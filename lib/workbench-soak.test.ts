import { describe, expect, it } from "vitest";
import {
  buildSoakReport,
  flakiestFailure,
  runWorkbenchSoak,
  type SoakRunOutcome,
} from "@/lib/workbench-soak";

function pass(): SoakRunOutcome {
  return { passed: true, failureTags: [], attempts: 1, wallClockMs: 100 };
}
function fail(tags: string[], attempts = 3): SoakRunOutcome {
  return { passed: false, failureTags: tags, attempts, wallClockMs: 200 };
}

describe("buildSoakReport", () => {
  it("computes pass rate and meets the 18/20 bar", () => {
    const outcomes = [...Array(18).fill(0).map(pass), fail(["build_failed"]), fail(["interactions_failed"])];
    const report = buildSoakReport("wb_countdown", outcomes, 0.9);

    expect(report.iterations).toBe(20);
    expect(report.passed).toBe(18);
    expect(report.failed).toBe(2);
    expect(report.passRate).toBe(0.9);
    expect(report.meetsThreshold).toBe(true);
  });

  it("falls below the bar at 17/20 and surfaces the flakiest failure", () => {
    const outcomes = [
      ...Array(17).fill(0).map(pass),
      fail(["build_failed"]),
      fail(["build_failed"]),
      fail(["critic_failed"]),
    ];
    const report = buildSoakReport("wb_countdown", outcomes, 0.9);

    expect(report.passRate).toBe(0.85);
    expect(report.meetsThreshold).toBe(false);
    // build_failed (2) ranks above critic_failed (1) — fix it first.
    expect(report.failureHistogram[0]).toEqual({ tag: "build_failed", count: 2 });
    expect(flakiestFailure(report)).toBe("build_failed");
  });

  it("reports an empty soak as not meeting the bar", () => {
    const report = buildSoakReport("wb_countdown", [], 0.9);
    expect(report.passRate).toBe(0);
    expect(report.meetsThreshold).toBe(false);
    expect(flakiestFailure(report)).toBeUndefined();
  });

  it("computes median attempts across runs", () => {
    const report = buildSoakReport("wb_x", [pass(), fail(["build_failed"], 3), fail(["critic_failed"], 5)], 0.9);
    expect(report.medianAttempts).toBe(3);
  });
});

describe("runWorkbenchSoak", () => {
  it("runs the injected runner once per iteration and aggregates", async () => {
    const calls: number[] = [];
    const report = await runWorkbenchSoak({
      objectiveId: "wb_countdown",
      iterations: 5,
      threshold: 0.9,
      runOnce: async (iteration) => {
        calls.push(iteration);
        // Fail the 5th run → 4/5 = 0.8, below bar.
        return iteration === 4 ? fail(["build_failed"]) : pass();
      },
    });

    expect(calls).toEqual([0, 1, 2, 3, 4]);
    expect(report.passed).toBe(4);
    expect(report.passRate).toBe(0.8);
    expect(report.meetsThreshold).toBe(false);
  });
});
