/**
 * [S3] `delegate_task` in solo: the parent side (item 4; council A11, C10).
 *
 * While a solo run drives, it binds its route (`tools/delegate/solo-route.ts`), so the one
 * `delegate_task` adapter of the tool build delegates through THIS run. Each task, one at a time
 * (C10: a local runtime has one slot; the adapter fans out, the route queues), is checked and then
 * handed to the conversation's delegation:
 *   refused   `agent.solo.delegate: off`; deeper than `agent.solo.max_delegation_depth`; no tool calls
 *             or cents left in the parent's budget; a fleet child while the conversation is tainted.
 *   run       with a slice of the parent's budget: the calls the parent has left (and the child's are
 *             counted against the parent afterwards), and the cents left under `budget.per_run_cap`.
 *             The child's model calls are charged to the PARENT's run scope, so there is one ledger
 *             row set and the parent's own cap sees them; the slice stops the child first.
 * Afterwards the child's taint is merged into the conversation's (what it read since it started), so
 * a secret or a page a child read holds the parent's next call exactly as if the parent had read it,
 * and the child's calls, cents and tokens are added to the parent's step.
 */
import type { SessionTaint, SessionTaintSnapshot } from "../governance/provenance.js";
import { snapshotSessionTaint } from "../governance/provenance.js";
import { bindDelegateRoute, unbindDelegateRoute } from "../tools/delegate/solo-route.js";
import type { DelegateRequest, DelegateResult } from "../tools/delegate/types.js";
import type { SoloChildOutcome, SoloDelegation } from "./delegate.js";
import { SOLO_SEAT, type SoloMeter, type SoloRunnerDeps } from "./types.js";

export interface DelegationBinding {
  readonly runId: string;
  /** The binding run's own depth: 0 for a conversation. */
  readonly depth: number;
  readonly delegation: SoloDelegation;
  readonly meter: SoloMeter;
  /** The parent's tool calls left, the delegate call itself already counted. */
  readonly callsLeft: () => number;
  readonly taint: () => SessionTaint;
  readonly signal?: AbortSignal;
  readonly sessionId?: string;
  /** Adds what a child spent and did to the parent's step and cap. */
  readonly spent: (outcome: SoloChildOutcome) => void;
}

/** The parent's meter as a child sees it: charged to the parent's run, stopped at the child's slice. */
export function sliceMeter(parent: SoloMeter, parentRunId: string, capCents: number | undefined): SoloMeter {
  let spent = 0;
  return {
    record(_childRunId, call) {
      const cents = parent.record(parentRunId, call);
      spent += cents;
      return cents;
    },
    stopReason() {
      if (capCents !== undefined && spent >= capCents) return `the delegated task spent its ${String(capCents)}-cent slice of the run's budget (budget.per_run_cap)`;
      return parent.stopReason?.(parentRunId);
    },
    remaining: () => (capCents === undefined ? undefined : Math.max(0, capCents - spent)),
  };
}

/** Adds to `target` what a child's conversation recorded since `since` (ms), and every untrusted source it read. */
export function mergeSessionTaint(target: SessionTaint, from: SessionTaintSnapshot, since: number): void {
  for (const call of from.calls) if (call.at >= since) target.calls.push({ tool: call.tool, classes: [...call.classes], at: call.at });
  for (const source of from.sources) if (!target.sources.includes(source)) target.sources.push(source);
}

/** A conversation that read a secret or untrusted content: a fleet child could not be told. */
export function isTainted(taint: SessionTaintSnapshot): boolean {
  return taint.sources.length > 0 || taint.calls.some((call) => call.classes.includes("secret_access"));
}

const refused = (output: string): DelegateResult => ({ status: "blocked", output });

async function delegateOnce(binding: DelegationBinding, request: DelegateRequest): Promise<DelegateResult> {
  const { delegation } = binding;
  if (delegation.mode === "off") return refused("delegate_task is off in this conversation (agent.solo.delegate: off); do this part yourself.");
  const depth = binding.depth + 1;
  if (depth > delegation.maxDepth) {
    return refused(`delegate_task: delegation depth ${String(depth)} exceeds the cap of ${String(delegation.maxDepth)} (agent.solo.max_delegation_depth); do this part yourself.`);
  }
  const calls = binding.callsLeft();
  if (calls < 1) return refused("delegate_task: this run has no tool calls left for a delegated task; answer from what you have.");
  const cents = binding.meter.remaining?.(binding.runId);
  if (cents !== undefined && cents <= 0) return refused("delegate_task: this run's budget is spent (budget.per_run_cap), so nothing was delegated.");
  const taint = snapshotSessionTaint(binding.taint());
  if (delegation.mode === "fleet" && isTainted(taint)) {
    return refused("delegate_task: refused while this conversation is tainted (it read a secret or untrusted content): a fleet child starts with a clean policy ring, so it could send what this conversation read. Do it here, or start a new session.");
  }
  const since = Date.now();
  const outcome = await delegation.run({
    task: request.task,
    ...(request.context === undefined ? {} : { context: request.context }),
    ...(request.agent === undefined ? {} : { agent: request.agent }),
    depth,
    maxToolCalls: calls,
    meter: sliceMeter(binding.meter, binding.runId, cents),
    taint,
    parentRunId: binding.runId,
    ...(binding.sessionId === undefined ? {} : { parentSessionId: binding.sessionId }),
    ...(binding.signal === undefined ? {} : { signal: binding.signal }),
  });
  mergeSessionTaint(binding.taint(), outcome.taint, since);
  binding.spent(outcome);
  return {
    status: outcome.status,
    output: outcome.output,
    agent: delegation.mode === "fleet" ? "fleet" : SOLO_SEAT,
    ...(outcome.runId === undefined ? {} : { runId: outcome.runId }),
    toolCalls: [...outcome.toolCalls],
  };
}

/** Binds `binding.runId`'s route; returns the unbind. Tasks run one at a time, in the order they were asked for. */
export function bindSoloDelegation(binding: DelegationBinding): () => void {
  let queue: Promise<unknown> = Promise.resolve();
  bindDelegateRoute(binding.runId, {
    delegate(request) {
      const next = queue.then(() => delegateOnce(binding, request));
      queue = next.catch(() => undefined);
      return next;
    },
  });
  return () => unbindDelegateRoute(binding.runId);
}

/** The part of a run's state a child's spend is added to (`TurnState` satisfies it). */
export interface RunTally {
  callsMade: number;
  costCents: number;
  tokens: number;
}

/** The runner's one call: binds the run's route when the conversation has a delegation; returns the unbind. */
export function bindRunDelegation(input: {
  readonly deps: Pick<SoloRunnerDeps, "delegation" | "depth" | "meter" | "sessionId">;
  readonly runId: string;
  readonly state: RunTally;
  readonly maxToolCalls: number;
  readonly taint: () => SessionTaint;
  readonly signal: AbortSignal | undefined;
}): (() => void) | undefined {
  const { deps, state } = input;
  if (deps.delegation === undefined) return undefined;
  return bindSoloDelegation({
    runId: input.runId,
    depth: deps.depth ?? 0,
    delegation: deps.delegation,
    meter: deps.meter,
    callsLeft: () => input.maxToolCalls - state.callsMade - 1,
    taint: input.taint,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    ...(deps.sessionId === undefined ? {} : { sessionId: deps.sessionId }),
    spent: (outcome) => {
      state.costCents += outcome.costCents;
      state.tokens += outcome.tokens;
      state.callsMade += outcome.callsMade;
    },
  });
}
