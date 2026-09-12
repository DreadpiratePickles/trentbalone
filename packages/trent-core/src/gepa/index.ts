/**
 * `@trent/core` wrapper over `apps/web/lib/gepa.ts`.
 *
 * GEPA (Genetic-Pareto reflective prompt evolution) is a MIXED module: the
 * frontier maths and prompt building are pure, but `evolveRolePrompt` calls an
 * LLM and scores the candidate through the eval gate. So:
 *
 *   - the pure helpers are thin typed re-exports, usable anywhere;
 *   - the impure pass is behind `createGepaEngine()`, an async factory that
 *     takes injected dependencies and defaults `skipLLM` to TRUE so the CLI
 *     runs offline unless a caller deliberately opts into a model call.
 *
 * Wraps: apps/web/lib/gepa.ts
 */

import {
  buildReflectionPrompt as libBuildReflectionPrompt,
  emptyFrontier as libEmptyFrontier,
  parseReflectionResponse as libParseReflectionResponse,
  updateParetoFrontier as libUpdateParetoFrontier,
  worstPerformingRole as libWorstPerformingRole,
} from "@/lib/gepa";
// Trace and eval types keep a single home in their own wrappers.
import type { AgentRole, TraceRecord } from "../traces/trace-store.js";
import type { EvalSuiteInput, EvalSuiteResult } from "../evals/index.js";

/** One candidate system prompt with its eval score and failure profile. */
export type GEPACandidate = {
  id: string;
  roleId: AgentRole;
  proposedPrompt: string;
  /** Natural-language rationale produced by the reflection step. */
  reflectionRationale: string;
  /** Eval-gate score on the frozen suite (0..1). */
  score: number;
  /** Signed delta vs the baseline at the time of evaluation. */
  delta: number;
  /** Failure clusters from the eval result — the Pareto diversity axis. */
  failureClusters: Record<string, number>;
  createdAt: string;
};

/** A small diverse set of top-performing prompt candidates for one role. */
export type GEPAFrontier = {
  roleId: AgentRole;
  best: GEPACandidate | null;
  candidates: GEPACandidate[];
  updatedAt: string;
};

export type ReflectionProposal = {
  rationale: string;
  proposedPrompt: string;
};

/** Mirrors `EvalGateBaseline` in apps/web/lib/eval-gate.ts. */
export type EvalGateBaseline = {
  score: number;
  failureClusters: Record<string, number>;
};

/** Mirrors `EvalGateDecision` in apps/web/lib/eval-gate.ts. */
export type EvalGateDecision = {
  promoted: boolean;
  score: number;
  delta: number;
  blockedBy?: "regression" | "new_failure_cluster" | "no_improvement";
  result: EvalSuiteResult;
};

// ─── Pure helpers ────────────────────────────────────────────────────────────

/** Build the prompt that asks a model to diagnose failing traces. */
export function buildReflectionPrompt(
  role: AgentRole,
  currentPrompt: string,
  failingTraces: readonly TraceRecord[],
): string {
  return libBuildReflectionPrompt(
    role,
    currentPrompt,
    failingTraces as unknown as Parameters<typeof libBuildReflectionPrompt>[2],
  );
}

/** Parse a reflection response; falls back to the current prompt on bad JSON. */
export function parseReflectionResponse(raw: string, fallbackPrompt: string): ReflectionProposal {
  return libParseReflectionResponse(raw, fallbackPrompt);
}

/**
 * Add a candidate to the Pareto frontier: at most one entry per distinct
 * failure-cluster profile, keeping the best scorer of each, capped at
 * `maxSize`. Returns a NEW frontier — the input object is never mutated.
 */
export function updateParetoFrontier(
  frontier: GEPAFrontier,
  incoming: GEPACandidate,
  maxSize?: number,
): GEPAFrontier {
  return libUpdateParetoFrontier(
    frontier as unknown as Parameters<typeof libUpdateParetoFrontier>[0],
    incoming as unknown as Parameters<typeof libUpdateParetoFrontier>[1],
    maxSize,
  ) as unknown as GEPAFrontier;
}

/** The role with the worst average eval score; null when nothing is scored. */
export function worstPerformingRole(traces: readonly TraceRecord[]): AgentRole | null {
  return libWorstPerformingRole(
    traces as unknown as Parameters<typeof libWorstPerformingRole>[0],
  ) as AgentRole | null;
}

/** An empty frontier for a role. */
export function emptyFrontier(roleId: AgentRole, now?: string): GEPAFrontier {
  return libEmptyFrontier(roleId, now) as unknown as GEPAFrontier;
}

// ─── Impure pass, behind an async factory ────────────────────────────────────

export type GepaEngineOptions = {
  /**
   * Skip the reflection model call and apply a deterministic minimal edit.
   * Defaults to TRUE so `@trent/core` runs offline out of the box; pass false
   * only when a real provider key is present.
   */
  skipLLM?: boolean;
  maxFrontierSize?: number;
};

export type EvolveRequest = {
  roleId: AgentRole;
  currentPrompt: string;
  failingTraces: readonly TraceRecord[];
  frozenSuite: Omit<EvalSuiteInput, "subjectId" | "previousScore">;
  baseline: EvalGateBaseline;
  frontier: GEPAFrontier;
  /** Deterministic candidate id and timestamp for tests. */
  id?: string;
  now?: string;
};

export type GepaEngine = {
  evolve(request: EvolveRequest): Promise<{ frontier: GEPAFrontier; decision: EvalGateDecision } | null>;
};

/**
 * Build a GEPA engine. Async because the impure half of `lib/gepa.ts` is loaded
 * on demand, after the caller's environment contract has been applied.
 */
export async function createGepaEngine(options: GepaEngineOptions = {}): Promise<GepaEngine> {
  const { evolveRolePrompt } = await import("@/lib/gepa");
  const skipLLM = options.skipLLM ?? true;

  return {
    async evolve(request) {
      const result = await evolveRolePrompt(
        request.roleId,
        request.currentPrompt,
        request.failingTraces as unknown as Parameters<typeof evolveRolePrompt>[2],
        request.frozenSuite as unknown as Parameters<typeof evolveRolePrompt>[3],
        request.baseline,
        request.frontier as unknown as Parameters<typeof evolveRolePrompt>[5],
        {
          skipLLM,
          maxFrontierSize: options.maxFrontierSize,
          id: request.id,
          now: request.now,
        },
      );
      return result as unknown as { frontier: GEPAFrontier; decision: EvalGateDecision } | null;
    },
  };
}
