/**
 * lib/orchestration-bakeoff.ts — orchestration guide Task 3.1.
 *
 * Nightly A/B bake-off: run flag/prompt permutations against the frozen
 * integration suite and emit a comparative scorecard (pass rate, cost,
 * latency) plus a recommendation. NO auto-promotion — the output is a report
 * a human (or the morning briefing) reads; flipping a flag in prod stays a
 * deliberate act.
 *
 * The suite runner is injected so unit tests stub it; the real entry point
 * (scripts/evals/run-orchestration-bakeoff.ts) passes the mock-provider
 * integration suite, which needs no API keys.
 */
import {
  buildOrchestrationEvalScorecard,
  buildOrchestrationSmokeReproducibility,
  partitionQuarantinedResults,
  type OrchestrationEvalResult,
  type OrchestrationEvalScorecard,
} from "@/lib/orchestration-eval";
import { nowIso } from "@/lib/utils";

export type BakeoffVariant = {
  id: string;
  description: string;
  /** Env values applied for the variant's suite run ("" clears the flag). */
  env: Record<string, string>;
};

export type BakeoffVariantResult = {
  variantId: string;
  description: string;
  scorecard: OrchestrationEvalScorecard;
  quarantinedCount: number;
  wallClockMs: number;
};

export type BakeoffReport = {
  suite: "orchestration_bakeoff";
  startedAt: string;
  completedAt: string;
  variants: BakeoffVariantResult[];
  recommendation: {
    variantId: string;
    rationale: string;
  };
};

/**
 * The permutations worth re-measuring nightly: every shipped-but-dark flag,
 * alone and combined. A flag graduates out of the bake-off when it is either
 * promoted to default-on or deleted.
 */
export function defaultBakeoffVariants(): BakeoffVariant[] {
  return [
    {
      id: "baseline",
      description: "Current production defaults (all experimental flags off)",
      env: { CRITIC_RUBRIC_ENABLED: "", ORCHESTRATION_PLAN_VALIDATOR_ENABLED: "" },
    },
    {
      id: "rubric_critic",
      description: "Scored critic rubric with deterministic verdict guard (Task 2.1)",
      env: { CRITIC_RUBRIC_ENABLED: "1", ORCHESTRATION_PLAN_VALIDATOR_ENABLED: "" },
    },
    {
      id: "plan_validator",
      description: "Plan DAG/spec validator gating execution (Task 1.2)",
      env: { CRITIC_RUBRIC_ENABLED: "", ORCHESTRATION_PLAN_VALIDATOR_ENABLED: "1" },
    },
    {
      id: "rubric_plus_validator",
      description: "Rubric critic + plan validator combined",
      env: { CRITIC_RUBRIC_ENABLED: "1", ORCHESTRATION_PLAN_VALIDATOR_ENABLED: "1" },
    },
  ];
}

type SuiteRunner = () => Promise<OrchestrationEvalResult[]>;

function applyEnv(env: Record<string, string>): Map<string, string | undefined> {
  const saved = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(env)) {
    saved.set(key, process.env[key]);
    if (value === "") delete process.env[key];
    else process.env[key] = value;
  }
  return saved;
}

function restoreEnv(saved: Map<string, string | undefined>): void {
  for (const [key, value] of saved) {
    // Assigning undefined would store the string "undefined" — delete instead.
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

export async function runOrchestrationBakeoff(options: {
  runSuite: SuiteRunner;
  variants?: BakeoffVariant[];
}): Promise<BakeoffReport> {
  const variants = options.variants ?? defaultBakeoffVariants();
  const startedAt = nowIso();
  const results: BakeoffVariantResult[] = [];

  for (const variant of variants) {
    const saved = applyEnv(variant.env);
    const variantStart = Date.now();
    try {
      const suiteResults = await options.runSuite();
      const { blocking, quarantined } = partitionQuarantinedResults(suiteResults);
      results.push({
        variantId: variant.id,
        description: variant.description,
        scorecard: buildOrchestrationEvalScorecard(blocking, buildOrchestrationSmokeReproducibility(blocking)),
        quarantinedCount: quarantined.length,
        wallClockMs: Date.now() - variantStart,
      });
    } finally {
      restoreEnv(saved);
    }
  }

  return {
    suite: "orchestration_bakeoff",
    startedAt,
    completedAt: nowIso(),
    variants: results,
    recommendation: recommendVariant(results),
  };
}

/**
 * Pass rate decides; cost breaks ties; latency breaks cost ties. Equal on all
 * three → keep the baseline (first variant), because changing a flag needs a
 * reason.
 */
export function recommendVariant(results: BakeoffVariantResult[]): BakeoffReport["recommendation"] {
  if (!results.length) return { variantId: "none", rationale: "No variants ran." };
  let best = results[0]!;
  for (const candidate of results.slice(1)) {
    if (candidate.scorecard.passRate > best.scorecard.passRate) { best = candidate; continue; }
    if (candidate.scorecard.passRate < best.scorecard.passRate) continue;
    if (candidate.scorecard.medianCostCents < best.scorecard.medianCostCents) { best = candidate; continue; }
    if (candidate.scorecard.medianCostCents > best.scorecard.medianCostCents) continue;
    if (candidate.scorecard.medianWallClockMs < best.scorecard.medianWallClockMs) best = candidate;
  }
  const others = results.filter((item) => item.variantId !== best.variantId);
  const rationale = [
    `passRate=${best.scorecard.passRate}`,
    `medianCostCents=${best.scorecard.medianCostCents}`,
    `medianWallClockMs=${best.scorecard.medianWallClockMs}`,
    others.length
      ? `vs ${others.map((item) => `${item.variantId}(passRate=${item.scorecard.passRate})`).join(", ")}`
      : "only variant",
    "No auto-promotion: flip the flag deliberately if this holds across nights.",
  ].join("; ");
  return { variantId: best.variantId, rationale };
}
