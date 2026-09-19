/**
 * [D1] the judge's model — plan decision 6.
 *
 * `createGatewayJudge` binds the judge to whatever gateway it is handed, and the CLI handed it the
 * gateway it had: the executor's. A judge that is the executor shares the executor's blind spots
 * and its idea of a good answer, and the rate that would expose it (TNR, [D0] gate 6) is the one a
 * self-grading judge inflates. So the two ids must differ, and the CLI resolves the judge's model
 * here rather than defaulting a string into config:
 *
 *   configured     `improve.judge_model`, when an operator set one — it wins over everything;
 *   planner_tier   the configured planner-tier model, when it differs from the executor
 *                  (`models.planner`, the strong tier `orchestrator/model-env.ts` maps);
 *   priced_gemini  otherwise the strongest model in the wrapper's own price table
 *                  (`model-gateway/pricing.ts`) whose id differs from the executor's.
 *
 * Decision 6 accepts that on one key this is a different model of the SAME family, and records
 * that as a limit until a second provider key exists (docs/improve.md). The limit it does not
 * accept is a judge equal to the executor: that is a configuration error naming both models.
 */

import { EXIT, TrentError } from "../errors/index.js";
import { MODEL_PRICE_TABLE } from "../model-gateway/pricing.js";

export type JudgeModelSource = "configured" | "planner_tier" | "priced_gemini";

export interface ResolvedJudgeModel {
  readonly model: string;
  readonly source: JudgeModelSource;
}

export interface JudgeModelInput {
  /** `improve.judge_model`. Empty or absent means "resolve it". */
  readonly configured?: string;
  /** The model the gate's actuals runner executes with. */
  readonly executor: string;
  /** `models.planner`, when the profile configures model tiers. */
  readonly planner?: string;
  /** Candidate ids in preference order. Defaults to the priced Gemini ids, strongest first. */
  readonly priced?: readonly string[];
}

/** Priced Gemini ids, most expensive output first — the price table's own ranking of strength. */
export function pricedGeminiModels(): string[] {
  return Object.entries(MODEL_PRICE_TABLE)
    .filter(([id]) => id.startsWith("gemini-"))
    .sort((a, b) => {
      const output = b[1].outputMicroCentsPerMillion - a[1].outputMicroCentsPerMillion;
      if (output !== 0) return output;
      const input = b[1].inputMicroCentsPerMillion - a[1].inputMicroCentsPerMillion;
      return input !== 0 ? input : a[0].localeCompare(b[0]);
    })
    .map(([id]) => id);
}

/** The strongest priced Gemini model that is not `executor`. Undefined when the table holds none. */
export function strongestPricedGemini(executor: string): string | undefined {
  return pricedGeminiModels().find((id) => id !== executor);
}

function configError(message: string): TrentError {
  return new TrentError({ code: EXIT.CONFIG, operation: "improve.judge", message });
}

export function resolveJudgeModel(input: JudgeModelInput): ResolvedJudgeModel {
  const executor = input.executor.trim();
  const configured = input.configured?.trim() ?? "";
  if (configured !== "") {
    if (configured === executor) {
      throw configError(
        `the judge and the executor must be different models, and both are ${executor}: set improve.judge_model to another model, or leave it empty to resolve one`,
      );
    }
    return { model: configured, source: "configured" };
  }

  const planner = input.planner?.trim() ?? "";
  if (planner !== "" && planner !== executor) return { model: planner, source: "planner_tier" };

  const candidates = input.priced ?? pricedGeminiModels();
  const priced = candidates.find((id) => id !== executor);
  if (priced === undefined) {
    throw configError(
      `no priced model differs from the executor ${executor}, so the judge would grade its own output: set improve.judge_model to a different model`,
    );
  }
  return { model: priced, source: "priced_gemini" };
}
