/**
 * One GEPA evolution pass for one AGENT, on that agent's own persisted Pareto frontier.
 *
 * The app's `evolveRolePrompt` reflects and then scores through the non-executing gate, so its
 * score never depends on the proposal. Here the pure halves of the wrapped module are used
 * (reflection prompt, response parsing, frontier update) and the proposal is scored by
 * EXECUTING the frozen suite with the proposal swapped in for the seat prompt (`gate.ts`).
 * A passing proposal is staged as a quarantined prompt draft — the protected-prompt rule — and
 * only a human promotes it.
 */

import { buildReflectionPrompt, emptyFrontier, parseReflectionResponse, updateParetoFrontier, type GEPACandidate, type GEPAFrontier } from "../gepa/index.js";
import type { ImproveStorePort, IterationRow, JsonObject } from "../store/StorePort.js";
import type { TraceRecord } from "../traces/trace-store.js";
import type { GateCache } from "./gate-cache.js";
import { executeGate, type ActualsRunner, type GateBaseline, type JudgeFn } from "./gate.js";
import { newId, setHash } from "./ledger.js";
import { isBudgetExhausted } from "./meter.js";
import { SEAT_PROMPT_TASK_TYPE, stagePromptProposal } from "./protected-prompt.js";
import type { FrozenSuite } from "./suites.js";

/**
 * Sends the reflection prompt to a model and returns its raw reply. Injected; never a default.
 * Return the reply with its integer-cent cost so the sweep can count it; a bare string counts as
 * one call at 0 cents.
 */
export type ReflectFn = (reflectionPrompt: string) => Promise<string | { text: string; costCents: number }>;

export interface GepaPassInput {
  readonly store: ImproveStorePort;
  readonly companyId: string;
  readonly agentId: string;
  readonly role: TraceRecord["agentRole"];
  readonly traces: readonly TraceRecord[];
  readonly suite: FrozenSuite | undefined;
  readonly seatPrompt: () => Promise<string>;
  readonly baseline: () => Promise<GateBaseline | undefined>;
  readonly actuals?: ActualsRunner;
  readonly judge?: JudgeFn;
  readonly cache?: GateCache;
  readonly reflect?: ReflectFn;
  readonly skipLLM: boolean;
  readonly now: string;
}

export interface GepaPassResult {
  passed: boolean;
  bestScore?: number;
  skipped?: string;
  costCents: number;
}

const OFFLINE_EDIT = "\n<!-- gepa evolved -->";

function isFailing(trace: TraceRecord): boolean {
  return trace.status === "failed" || (trace.critiqueVerdict !== undefined && trace.critiqueVerdict !== "pass");
}

function storedFrontier(frontier: JsonObject | undefined, role: TraceRecord["agentRole"], now: string): { frontier: GEPAFrontier; inputHash: string | undefined } {
  if (!frontier || typeof frontier.roleId !== "string") return { frontier: emptyFrontier(role, now), inputHash: undefined };
  const { inputHash, ...rest } = frontier;
  return { frontier: rest as unknown as GEPAFrontier, inputHash: typeof inputHash === "string" ? inputHash : undefined };
}

/** One pass; a budget exhausted anywhere inside it is a skip, not an error. */
export async function runGepaPass(input: GepaPassInput): Promise<GepaPassResult> {
  try {
    return await gepaPass(input);
  } catch (error) {
    if (isBudgetExhausted(error)) return { passed: false, skipped: "budget_exhausted", costCents: 0 };
    throw error;
  }
}

async function gepaPass(input: GepaPassInput): Promise<GepaPassResult> {
  const failing = input.traces.filter(isFailing);
  if (failing.length === 0) return { passed: false, skipped: "no_failing_traces", costCents: 0 };
  if (!input.suite) return { passed: false, skipped: "no_suite", costCents: 0 };
  if (!input.actuals) return { passed: false, skipped: "no_gateway", costCents: 0 };

  const inputHash = setHash(failing.map((t) => t.id), input.suite.version);
  const existing = await input.store.getFrontier(input.companyId, input.agentId);
  const { frontier, inputHash: lastHash } = storedFrontier(existing?.frontier, input.role, input.now);
  if (lastHash === inputHash) return { passed: false, skipped: "unchanged", bestScore: frontier.best?.score, costCents: 0 };

  const currentPrompt = await input.seatPrompt();
  let proposal: { rationale: string; proposedPrompt: string };
  if (input.skipLLM) {
    proposal = { rationale: "Offline mode: minimal prompt change.", proposedPrompt: `${currentPrompt}${OFFLINE_EDIT}` };
  } else {
    if (!input.reflect) return { passed: false, skipped: "no_reflection_model", costCents: 0 };
    const raw = await input.reflect(buildReflectionPrompt(input.role, currentPrompt, failing));
    proposal = parseReflectionResponse(typeof raw === "string" ? raw : raw.text, currentPrompt);
  }

  const remember = (f: GEPAFrontier): Promise<void> =>
    input.store.putFrontier({
      companyId: input.companyId,
      agentId: input.agentId,
      frontier: { ...(JSON.parse(JSON.stringify(f)) as JsonObject), inputHash },
      updatedAt: input.now,
    });

  if (proposal.proposedPrompt === currentPrompt) {
    await remember(frontier);
    return { passed: false, skipped: "no_change", bestScore: frontier.best?.score, costCents: 0 };
  }
  const baseline = await input.baseline();
  if (!baseline) return { passed: false, skipped: "no_baseline", costCents: 0 };

  const candidateId = newId("gepa");
  const verdict = await executeGate({
    candidate: { id: candidateId, kind: "prompt", content: proposal.proposedPrompt },
    seatPrompt: currentPrompt,
    suite: input.suite,
    baseline,
    actuals: input.actuals,
    ...(input.judge === undefined ? {} : { judge: input.judge }),
    ...(input.cache === undefined ? {} : { cache: input.cache }),
  });

  const candidate: GEPACandidate = {
    id: candidateId,
    roleId: input.role,
    proposedPrompt: proposal.proposedPrompt,
    reflectionRationale: proposal.rationale,
    score: verdict.score,
    delta: verdict.delta,
    failureClusters: verdict.failureClusters,
    createdAt: input.now,
  };
  const updated = updateParetoFrontier(frontier, candidate);
  await remember(updated);

  const iteration: IterationRow = {
    id: newId("iter"),
    companyId: input.companyId,
    agentId: input.agentId,
    taskType: SEAT_PROMPT_TASK_TYPE,
    candidateId,
    candidateKind: "prompt",
    score: verdict.score,
    delta: verdict.delta,
    decision: verdict.promoted ? "pending_approval" : "rejected",
    triggers: ["gepa_reflection"],
    blockedBy: verdict.blockedBy ?? null,
    inputHash,
    verdicts: JSON.parse(JSON.stringify(verdict)) as JsonObject,
    createdAt: input.now,
  };
  await input.store.appendIteration(iteration);
  if (verdict.promoted) {
    await stagePromptProposal(input.store, {
      companyId: input.companyId,
      agentId: input.agentId,
      iterationId: iteration.id,
      proposedPrompt: proposal.proposedPrompt,
      now: input.now,
    });
  }
  return { passed: true, bestScore: updated.best?.score, costCents: verdict.costCents };
}
