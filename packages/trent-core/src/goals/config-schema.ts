/**
 * D4 — the `goals` config block, defined beside the module that reads it.
 *
 * `verify_on_stop` is on by default, because the failure it prevents is a run that edited code and
 * then said it was done: the cheapest, most repeated failure a coding harness has. Turning it off
 * is a decision a profile can make; it is not a decision an agent can make for itself, which is why
 * the key lives here and not in a prompt.
 *
 * `auto_continue` is OFF by default. A red gate that silently starts another metered run is a bill
 * nobody authorised; `trent goal continue <id>` is the explicit path, and `max_continuations`
 * bounds both. `verify_commands` defaults to `DEFAULT_VERIFY_COMMANDS`, not a copy of it, so the
 * documented list and the enforced one cannot drift.
 *
 * It lives here rather than in `config/schema.ts` so the block costs that file three lines: the
 * schema is already at the repository's 500-line ceiling. See docs/goals.md.
 */

import { z } from "zod";
import { DEFAULT_MAX_CONTINUATIONS, DEFAULT_VERIFY_COMMANDS } from "./types.js";

export const GoalsConfigSchema = z
  .object({
    verify_on_stop: z.boolean().default(true),
    verify_commands: z.array(z.string().min(1)).default([...DEFAULT_VERIFY_COMMANDS]),
    auto_continue: z.boolean().default(false),
    max_continuations: z.number().int().min(0).default(DEFAULT_MAX_CONTINUATIONS),
  })
  .strict();

export type GoalsConfig = z.infer<typeof GoalsConfigSchema>;

/** The block as every reader here wants it, with nothing optional left to re-default downstream. */
export function goalsConfig(input?: Partial<GoalsConfig>): GoalsConfig {
  return GoalsConfigSchema.parse(input ?? {});
}
