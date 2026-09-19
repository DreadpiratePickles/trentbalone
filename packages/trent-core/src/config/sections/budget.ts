/**
 * The `budget` block of `TrentConfigSchema`. Composed in `config/schema.ts`, which re-exports
 * every name here.
 */

import { z } from "zod";

/**
 * Money is INTEGER CENTS everywhere, never floating-point dollars — this matches the
 * rule the rest of the platform already follows. `daily_cap: 1000` is USD 10.00.
 * `alert_thresholds` stays a list of PERCENTAGES, not money.
 */
/** Integer cents. Named because `improve.sweep_cap_cents` defaults to it (plan decision 8). */
export const DEFAULT_BUDGET_PER_RUN_CAP = 100;

export const BudgetConfigSchema = z.object({
  daily_cap: z.number().int().positive().default(1000),
  currency: z.string().default("USD"),
  per_run_cap: z.number().int().positive().default(DEFAULT_BUDGET_PER_RUN_CAP),
  alert_thresholds: z.array(z.number()).default([50, 80, 100]),
});
