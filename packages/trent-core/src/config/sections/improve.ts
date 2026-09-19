/**
 * The `improve` block of `TrentConfigSchema`. Composed in `config/schema.ts`.
 */

import { z } from "zod";
import { DEFAULT_BUDGET_PER_RUN_CAP } from "./budget.js";

// [D0] improvement gates
/**
 * The gates the self-improvement loop is held to before any reflection is switched on
 * (docs/improve.md). `holdout_ratio` is the share of every suite's fixtures held back from
 * reflection and scoring and used for promotion alone; `pass_k` is how many consecutive trials
 * a fixture must pass to count as passed; `judge_min_tpr` / `judge_min_tnr` are the calibration
 * floors below which the judge's verdicts are advisory and cannot make a fixture pass;
 * `sweep_cap_cents` is the sweep's hard spend cap in INTEGER CENTS and defaults to
 * `budget.per_run_cap` (plan decision 8); `frozen_paths` are extra paths the loop may never
 * write, on top of the suites, the goldens, the judge prompt and the gate code.
 */
export const ImproveConfigSchema = z.object({
  holdout_ratio: z.number().gt(0).lt(1).default(0.3),
  pass_k: z.number().int().min(1).default(3),
  judge_min_tpr: z.number().min(0).max(1).default(0.8),
  judge_min_tnr: z.number().min(0).max(1).default(0.8),
  sweep_cap_cents: z.number().int().positive().default(DEFAULT_BUDGET_PER_RUN_CAP),
  frozen_paths: z.array(z.string().min(1)).default([]),
  // [D1] judge
  /**
   * Reflection, and who grades it (docs/improve.md, "The judge model" and "Reflection").
   *
   * `judge_model` is the model the eval judge runs on. EMPTY is not "no judge": it means
   * resolve one at run time (`improve/judge-model.ts`) — the configured planner-tier model when
   * it differs from the executor, else the strongest priced Gemini model that does. The judge
   * and the executor may never be the same id; equal models are a configuration error naming
   * both. On one key the two are the same family, which plan decision 6 records as the limit
   * until a second provider key exists.
   *
   * `min_goldens` is how many PROMOTED goldens a seat's suite must hold before `trent improve
   * sweep --live` will spend a model call reflecting for it. Below it the sweep refuses and
   * names the counts: a reflection measured on one or two fixtures is noise with a bill.
   */
  judge_model: z.string().default(""),
  min_goldens: z.number().int().min(1).default(5),
});
