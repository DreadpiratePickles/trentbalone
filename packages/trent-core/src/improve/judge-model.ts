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
 *
 * [L0-3] G6: under a local provider neither fallback applies. The priced table is hosted (it sent
 * a Gemini id to Ollama), so only `improve.judge_model`, naming a second local model, is accepted.
 */

import { EXIT, TrentError } from "../errors/index.js";
import { MODEL_PRICE_TABLE } from "../model-gateway/pricing.js";
import { KEYLESS_ALIASES } from "../model-gateway/providers.js";

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
  /**
   * [L0-3] G6: the configured provider. Under a local one (`ollama`, `lmstudio`) there is no
   * fallback: `improve.judge_model` must name a second local model, or the judge refuses.
   */
  readonly provider?: string;
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

/** Hosted, whatever endpoint the alias points at: a priced id, or an Ollama cloud model (`:cloud`). */
function isHostedModel(id: string): boolean {
  return id in MODEL_PRICE_TABLE || /[:-]cloud$/i.test(id);
}

export function resolveJudgeModel(input: JudgeModelInput): ResolvedJudgeModel {
  const executor = input.executor.trim();
  const configured = input.configured?.trim() ?? "";
  const local = input.provider !== undefined && KEYLESS_ALIASES.has(input.provider.trim().toLowerCase());
  if (configured !== "") {
    if (configured === executor) {
      throw configError(
        `the judge and the executor must be different models, and both are ${executor}: set improve.judge_model to another model, or leave it empty to resolve one`,
      );
    }
    if (local && isHostedModel(configured)) {
      throw configError(
        `judge needs a second local model: ${configured} is a hosted model, and under provider ${input.provider} the judge never leaves this machine; set improve.judge_model to another model pulled locally`,
      );
    }
    return { model: configured, source: "configured" };
  }

  // [L0-3] G6: a local profile never falls back, to the planner tier or to the priced (hosted) table.
  if (local) {
    throw configError(
      `judge needs a second local model: set improve.judge_model to a model pulled locally other than the executor ${executor}; under provider ${input.provider} the judge never falls back to a hosted model`,
    );
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
