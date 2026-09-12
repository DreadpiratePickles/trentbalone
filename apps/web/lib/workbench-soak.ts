/**
 * lib/workbench-soak.ts — PARITY-PLAN P5 build-reliability soak.
 *
 * Done-bar: "a 'build me X, verify it renders' prompt passes ≥18/20 headless
 * runs with screenshot evidence and an honest pass/fail verdict." This is the
 * INSTRUMENT that produces that number: run one objective N times headless,
 * aggregate pass rate + failure-tag histogram, gate on a threshold.
 *
 * The per-run executor is injected so the same aggregation backs both the
 * mock-provider proof (no credentials) and a real E2B/Daytona soak (the
 * credentialed follow-up) — mirroring how the bake-off reuses the eval suite.
 */

export type SoakRunOutcome = {
  passed: boolean;
  /** Failure tags from scoreWorkbenchObjective (build_failed, interactions_failed, …). */
  failureTags: string[];
  attempts: number;
  wallClockMs: number;
};

export type SoakReport = {
  objectiveId: string;
  iterations: number;
  passed: number;
  failed: number;
  passRate: number;
  /** How many runs hit each failure tag, worst first — points at the flakiest failure. */
  failureHistogram: Array<{ tag: string; count: number }>;
  medianAttempts: number;
  /** True when passRate ≥ threshold (default 0.9 = 18/20). */
  meetsThreshold: boolean;
  threshold: number;
};

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Pure aggregation over the per-run outcomes. */
export function buildSoakReport(
  objectiveId: string,
  outcomes: SoakRunOutcome[],
  threshold = 0.9,
): SoakReport {
  const iterations = outcomes.length;
  const passed = outcomes.filter((outcome) => outcome.passed).length;
  const failed = iterations - passed;
  const passRate = iterations ? passed / iterations : 0;

  const tagCounts = new Map<string, number>();
  for (const outcome of outcomes) {
    for (const tag of outcome.failureTags) {
      tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
    }
  }
  const failureHistogram = [...tagCounts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));

  return {
    objectiveId,
    iterations,
    passed,
    failed,
    passRate: Math.round(passRate * 1000) / 1000,
    failureHistogram,
    medianAttempts: median(outcomes.map((outcome) => outcome.attempts)),
    meetsThreshold: iterations > 0 && passRate >= threshold,
    threshold,
  };
}

/** The single flakiest failure to fix next (P5: "fix the flakiest failure each iteration"). */
export function flakiestFailure(report: SoakReport): string | undefined {
  return report.failureHistogram[0]?.tag;
}

export type SoakRunner = (iteration: number) => Promise<SoakRunOutcome>;

/** Run an objective `iterations` times through the injected runner and aggregate. */
export async function runWorkbenchSoak(input: {
  objectiveId: string;
  iterations: number;
  runOnce: SoakRunner;
  threshold?: number;
}): Promise<SoakReport> {
  const outcomes: SoakRunOutcome[] = [];
  for (let i = 0; i < input.iterations; i++) {
    outcomes.push(await input.runOnce(i));
  }
  return buildSoakReport(input.objectiveId, outcomes, input.threshold);
}
