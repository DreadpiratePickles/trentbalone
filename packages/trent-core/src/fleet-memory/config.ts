/**
 * Budgets for what shared context a seat is handed. Characters, never tokens: the budget has to
 * be checked offline and identically on every provider. Every number here is a ceiling the
 * renderer proves, not a hint.
 */

export interface FleetMemoryConfig {
  /** Hard ceiling on the rendered cross-agent recall block, in characters. */
  readonly recallBudgetChars: number;
  /** Longest excerpt of one step output, run summary or skill in the recall block. */
  readonly recallSnippetChars: number;
  /** Most recent runs consulted for recall and search; older work is still on disk, not in the prelude. */
  readonly recallRunWindow: number;
  /** Lexical similarity below which a candidate is "unrelated" and never enters the block. */
  readonly recallMinScore: number;
  /** Default and maximum result counts for `fleet_search`. */
  readonly searchDefaultLimit: number;
  readonly searchMaxLimit: number;
  /** Longest excerpt per `fleet_search` hit. */
  readonly searchSnippetChars: number;
}

export const DEFAULT_FLEET_MEMORY_CONFIG: FleetMemoryConfig = {
  recallBudgetChars: 3_000,
  recallSnippetChars: 400,
  recallRunWindow: 200,
  recallMinScore: 0.12,
  searchDefaultLimit: 5,
  searchMaxLimit: 20,
  searchSnippetChars: 300,
};

/**
 * [C4] The one place a caller merges overrides onto the shipped budgets.
 *
 * This used to read `TRENT_FLEET_RECALL_BUDGET_CHARS`, which the README advertised and nothing
 * honoured: the only reader was this function and nothing called it, so the hook always used
 * `DEFAULT_FLEET_MEMORY_CONFIG` (fleet audit 3.3, 3.7). An operator who set the variable changed
 * nothing and was told nothing. The env read is deleted rather than wired up, because the only
 * place that could honour it is `orchestrator-hook.ts`, and a budget that the prelude must prove
 * offline and identically on every provider belongs in the config file, not in a shell.
 */
export function resolveFleetMemoryConfig(overrides: Partial<FleetMemoryConfig> = {}): FleetMemoryConfig {
  return { ...DEFAULT_FLEET_MEMORY_CONFIG, ...overrides };
}
