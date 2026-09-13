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

/** `TRENT_FLEET_RECALL_BUDGET_CHARS` overrides the recall budget; anything unparsable keeps the default. */
export function resolveFleetMemoryConfig(env: NodeJS.ProcessEnv = process.env, overrides: Partial<FleetMemoryConfig> = {}): FleetMemoryConfig {
  const fromEnv = Number.parseInt(env.TRENT_FLEET_RECALL_BUDGET_CHARS ?? "", 10);
  const recallBudgetChars = Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : DEFAULT_FLEET_MEMORY_CONFIG.recallBudgetChars;
  return { ...DEFAULT_FLEET_MEMORY_CONFIG, recallBudgetChars, ...overrides };
}
