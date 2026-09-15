/**
 * The TUI's budget ticker, on the same ledger the REPL uses.
 *
 * Nothing here is ever a float and nothing here is a literal: the cap and the alert
 * thresholds come from `config.budget`, the opening balance is what the fleet has
 * actually recorded today, and every later cent arrives from an orchestrator
 * `step_end` / `consolidate_end` event through `record`.
 */

import { useCallback, useState } from "react";
import type { ConfigManager } from "@trent/core";
import { BudgetLedger } from "../../repl/budget.js";

export interface TuiBudget {
  spentCents: number;
  capCents: number;
  /** Percentage of the cap consumed, rounded down. */
  percent: number;
  /** True once any configured threshold has been crossed this session. */
  warning: boolean;
  /**
   * Records one real integer-cent cost and returns the alert lines for every threshold
   * crossed by it, each announced exactly once.
   */
  record(costCents: number): string[];
}

export function useBudget(configManager: ConfigManager, openingCents: number): TuiBudget {
  const [ledger] = useState(() => {
    const config = configManager.loadConfig();
    return new BudgetLedger({
      capCents: config.budget.daily_cap,
      thresholds: config.budget.alert_thresholds,
      openingCents,
    });
  });
  // The ledger is mutable; this tick is what makes Ink re-render after a record.
  const [, setTick] = useState(0);

  const record = useCallback(
    (costCents: number): string[] => {
      ledger.record(costCents);
      setTick((n) => n + 1);
      return ledger.takeCrossed().map((threshold) => ledger.warningText(threshold));
    },
    [ledger],
  );

  return {
    spentCents: ledger.spentCents,
    capCents: ledger.capCents,
    percent: ledger.percent,
    warning: ledger.warning,
    record,
  };
}
