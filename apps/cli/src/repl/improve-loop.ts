/**
 * The self-improvement loop in the REPL run path: `createImproveRunDeps` (commands/improve.ts)
 * spread into `createOrchestrator`, so every run writes traces and every seat call sees the
 * skills a human promoted with `trent improve promote`. When the session's store has no improve
 * tables (plain Node, no bun:sqlite) the loop runs against the process-local store the
 * `improve` command also falls back to, so a promotion made in this process still reaches a seat.
 */

import type { ImproveStorePort } from "@trent/core/store/index.js";
import { createImproveRunDeps, fallbackImproveStore, type ImproveRunDeps } from "../commands/improve.js";

export interface ImproveLoopWiring {
  readonly store: unknown;
  readonly config: { fleet?: { installed_agents?: string[]; active_agents?: string[] } };
}

/** `store.improve()` when the store has one; the REPL's store type is structural and may not. */
function improveOf(store: unknown): ImproveStorePort | undefined {
  const candidate = store as { improve?: () => ImproveStorePort } | null | undefined;
  return typeof candidate?.improve === "function" ? candidate.improve() : undefined;
}

export function wireImproveLoop(input: ImproveLoopWiring): ImproveRunDeps {
  return createImproveRunDeps({
    store: improveOf(input.store) ?? fallbackImproveStore(),
    installedAgents: [...(input.config.fleet?.installed_agents ?? input.config.fleet?.active_agents ?? [])],
  });
}
