/**
 * The last surviving formatter from the previous REPL, kept only because
 * `apps/cli/src/slash/index.ts` (owned elsewhere) imports it. Everything else that used
 * to live here — the emoji metadata line, the purple banner, the canned agent message
 * formatter — is deleted; the REPL renders through `../ui` and `./render.ts` now.
 *
 * The old signature took dollars, so it is preserved and converted at the boundary:
 * inside, money is integer cents like everywhere else.
 */

import { autoTheme } from "../ui/index.js";
import { BudgetLedger } from "./budget.js";

const CENTS_PER_UNIT = 100;

/** @param spent dollars @param cap dollars-or-cents as the caller happens to hold them. */
export function formatBudgetTicker(spent: number, cap: number): string {
  const ledger = new BudgetLedger({
    capCents: Math.round(cap),
    thresholds: [],
    openingCents: Math.round(spent * CENTS_PER_UNIT),
  });
  return ledger.render(autoTheme());
}
