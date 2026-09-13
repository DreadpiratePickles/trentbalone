/**
 * Clean-trace distillation (task I.13; CS329A L5 @72:47-73:10, SWiRL: imitation needs data that
 * is clean on process AND outcome, because imitating a wrong-outcome trajectory hurts; L5 @67:02).
 *
 * When a human promotes a candidate, the run traces that earned it still carry the dead ends:
 * failed tool calls, retried steps, tool errors that preceded the final answer. The Foundry and
 * the GEPA reflection are imitation, so what they read must be the successful path only. This
 * module distils a raw trace into a `CleanGolden`: the ok steps in order, no errors, and a
 * `distilledFrom` pointer back to the raw trace so the provenance is auditable. A trace that was
 * blocked, or whose final step did not succeed, is never distilled: the outcome was not clean.
 *
 * `rawTraceFromRows` builds the raw trace from a run's `AgentTraceRow`s (one per step): a step is
 * ok when it completed and the critic did not send it back; a `blocked` step blocks the trace.
 */

import { createHash } from "node:crypto";

import type { AgentTraceRow } from "../store/StorePort.js";

export interface RawStep {
  readonly title: string;
  readonly tool?: string;
  readonly args?: unknown;
  readonly ok: boolean;
  readonly error?: string;
  readonly output?: string;
}

export interface RawTrace {
  readonly id: string;
  readonly runId: string;
  readonly agentId: string;
  readonly taskType: string;
  readonly objective?: string;
  /** A blocked run (approval refused, policy stop) is never an exemplar. */
  readonly blocked: boolean;
  readonly steps: readonly RawStep[];
}

export interface CleanStep {
  title: string;
  tool?: string;
  args?: unknown;
  output?: string;
  /** Never present: a clean step has no error by construction. Declared so callers can assert it. */
  error?: undefined;
}

export interface CleanGolden {
  id: string;
  agentId: string;
  taskType: string;
  objective?: string;
  /** The raw trace this golden was distilled from. */
  distilledFrom: string;
  runId: string;
  /** The candidate whose promotion produced it. */
  candidateId: string;
  steps: CleanStep[];
  /** Task I.14: one "why" per step, in step order, when a rationalisation ran. */
  rationale?: string[];
  /** sha256 of the step list the rationale was written for (content-addressed, I.14). */
  rationaleOf?: string;
  capturedAt: string;
}

export interface DistillContext {
  readonly candidateId: string;
  readonly now: string;
}

/** sha256 over the step list: the golden's content address for the rationale. */
export function goldenStepsHash(steps: readonly CleanStep[]): string {
  return createHash("sha256").update(JSON.stringify(steps.map((s) => [s.title, s.tool ?? null, s.args ?? null, s.output ?? null]))).digest("hex");
}

export function goldenId(distilledFrom: string, candidateId: string): string {
  return `golden_${createHash("sha256").update(`${distilledFrom}|${candidateId}`).digest("hex").slice(0, 16)}`;
}

/** The successful path only, or undefined when the trace is not clean enough to imitate. */
export function distillCleanTrace(raw: RawTrace, ctx: DistillContext): CleanGolden | undefined {
  if (raw.blocked) return undefined;
  const last = raw.steps[raw.steps.length - 1];
  if (!last || !last.ok) return undefined;
  const steps: CleanStep[] = raw.steps
    .filter((s) => s.ok)
    .map((s) => ({
      title: s.title,
      ...(s.tool === undefined ? {} : { tool: s.tool }),
      ...(s.args === undefined ? {} : { args: s.args }),
      ...(s.output === undefined ? {} : { output: s.output }),
    }));
  if (steps.length === 0) return undefined;
  return {
    id: goldenId(raw.id, ctx.candidateId),
    agentId: raw.agentId,
    taskType: raw.taskType,
    ...(raw.objective === undefined ? {} : { objective: raw.objective }),
    distilledFrom: raw.id,
    runId: raw.runId,
    candidateId: ctx.candidateId,
    steps,
    capturedAt: ctx.now,
  };
}

const NOT_OK_VERDICTS = new Set(["retry", "replan", "escalate"]);

/** One run's rows, oldest first, as a raw trace whose id is the run id. */
export function rawTraceFromRows(rows: readonly AgentTraceRow[]): RawTrace {
  const ordered = [...rows].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const first = ordered[0];
  return {
    id: first?.runId ?? "",
    runId: first?.runId ?? "",
    agentId: first?.agentId ?? "",
    taskType: first?.taskType ?? "",
    blocked: ordered.some((r) => r.status === "blocked"),
    steps: ordered.map((r) => {
      const ok = r.status === "completed" && !(r.critiqueVerdict !== null && NOT_OK_VERDICTS.has(r.critiqueVerdict));
      const loop = (r.failureTags ?? []).find((t) => t.startsWith("repetitive_loop"));
      return {
        title: r.stepTitle,
        ...(r.toolCalls[0] === undefined ? {} : { tool: r.toolCalls[0] }),
        ok: ok && loop === undefined,
        ...(ok && loop === undefined ? {} : { error: loop ?? (r.critiqueVerdict ?? r.status) }),
      };
    }),
  };
}

/** Rows grouped by run, each run's rows oldest first. */
export function groupRowsByRun(rows: readonly AgentTraceRow[]): Map<string, AgentTraceRow[]> {
  const byRun = new Map<string, AgentTraceRow[]>();
  for (const row of rows) byRun.set(row.runId, [...(byRun.get(row.runId) ?? []), row]);
  return byRun;
}
