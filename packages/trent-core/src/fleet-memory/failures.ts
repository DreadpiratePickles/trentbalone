/**
 * [C5] The failure channel.
 *
 * The fleet-brain audit (`01_discovery/output/fleet-brain-audit-2026-09-18.md` 3.5) states the
 * gap in four words: "failures have no channel at all". A step that lost an hour to a tool that
 * refuses a particular argument leaves nothing behind except its own output, which recall ranks
 * against the objective like any other paragraph and usually drops. The next seat with a related
 * objective starts from zero and loses the hour again.
 *
 * So failures get their OWN recall class, with three properties the generic path does not give:
 *
 *  1. **Compact and structured.** Objective, seat, the tool that failed, the failure tags and a
 *     one-line reason — not the step's whole output. A failure that costs 200 characters can be
 *     carried for a hundred runs; one that costs 4,000 cannot.
 *  2. **Stored under the brain**, as `brain/memory/YYYY-MM-DD.md` entries tagged `[failure]`,
 *     through `Brain.appendNote` and therefore under the same lock, the same 0600 write-then-
 *     rename and the same commit trail as every other brain write. Nothing new on disk.
 *  3. **Marked in the prompt.** The block a seat receives says `[failure]` on every line, because
 *     an unmarked "what other seats learned" line that is actually "what another seat tried and
 *     lost" is worse than no line: it reads as advice.
 *
 * Every field is passed through `redactTranscript` before it is written. A failure reason is the
 * most likely place in the whole system for a credential to appear — it is usually an error
 * message — and this file is durable, committed and loaded into later prompts.
 */
import { scoreAgainst, type EmbedFn } from "./lexical.js";
import { deriveTaskType } from "../improve/trace-writer.js";
import { provenanceOf, worstProvenance } from "../governance/provenance.js";
import { redactTranscript } from "../telemetry/redact.js";
import type { OrcEvent, OrchestrationStepSnapshot } from "../orchestrator/types.js";
import type { Provenance, ToolCallRecord } from "../tools/types.js";
import { DEFAULT_FLEET_MEMORY_CONFIG, type FleetMemoryConfig } from "./config.js";
import { BRAIN_MEMORY_DIR, type Brain, type BrainWriteResult } from "./brain.js";

/** The tag that makes an episodic note a failure. Greppable on disk and visible in the prompt. */
export const FAILURE_MARKER = "[failure]";

/** The CONTEXT-tier block name (`tiers.ts` block naming), so `/context` and the tests agree. */
export const FAILURES_BLOCK = "failures";

/** Share of `recallBudgetChars` the failures block may take. The rest stays with cross-agent recall. */
export const FAILURE_BUDGET_RATIO = 1 / 3;

const FIELD_SEPARATOR = " | ";
const OBJECTIVE_CHARS = 120;
const REASON_CHARS = 200;

/** What a failed step leaves behind. Everything here is redacted before it is written. */
export interface FailureRecord {
  readonly objective: string;
  readonly seat: string;
  /** The tool the step failed on, when one failed; a critic escalation names none. */
  readonly tool?: string;
  /** `AgentTraceRow.failureTags`: the detected modes, e.g. `repetitive_loop`. */
  readonly tags?: readonly string[];
  /** One line. The critic's verdict reason, or the failing tool's first summary line. */
  readonly reason: string;
  readonly runId?: string;
  readonly stepId?: string;
}

/** One failure read back off the brain. `text` is the line as it will be rendered. */
export interface RecalledFailure {
  readonly at: string;
  readonly seat: string;
  readonly objective: string;
  readonly tool: string;
  readonly tags: readonly string[];
  readonly reason: string;
  readonly runId: string | null;
  readonly text: string;
  readonly score: number;
}

export interface FailureRecallResult {
  readonly block: string;
  readonly chars: number;
  readonly items: readonly RecalledFailure[];
  /** Related failures the budget could not fit. */
  readonly dropped: number;
}

function one(text: string, limit: number): string {
  const clean = redactTranscript(String(text ?? "")).replace(/\s+/g, " ").trim();
  return clean.length <= limit ? clean : `${clean.slice(0, Math.max(0, limit - 3))}...`;
}

/** The note body: one line, the marker first, `key: value` fields in a fixed order. */
export function renderFailureNote(record: FailureRecord): string {
  const fields = [
    `objective: ${one(record.objective, OBJECTIVE_CHARS)}`,
    `seat: ${one(record.seat, 40)}`,
    `tool: ${one(record.tool ?? "none", 40)}`,
    `tags: ${record.tags?.length ? record.tags.map((tag) => one(tag, 40)).join(",") : "none"}`,
    `reason: ${one(record.reason, REASON_CHARS)}`,
  ];
  return `${FAILURE_MARKER} ${fields.join(FIELD_SEPARATOR)}`;
}

/**
 * Appends the record through the brain's own note API, so it lands in `brain/memory/<day>.md`
 * under the shared memory lock and is committed with the seat that failed as the writer.
 */
export function recordFailure(brain: Brain, record: FailureRecord): BrainWriteResult {
  return brain.appendNote({
    text: renderFailureNote(record),
    writer: record.seat,
    ...(record.runId === undefined ? {} : { runId: record.runId }),
  });
}

/**
 * The same write, made safe for a run to call: the brain is ADVISORY, so a read-only profile or a
 * wedged lock costs the channel and never the run. A failure that could not be recorded is not a
 * second failure.
 */
export function writeFailure(brain: Brain | undefined, record: FailureRecord): boolean {
  if (brain === undefined) return false;
  try {
    brain.ensure();
    recordFailure(brain, record);
    return true;
  } catch {
    return false;
  }
}

/** The event frame as the bus actually carries it; `OrcEvent["step"]` declares neither of these. */
type StepFrame = Partial<OrchestrationStepSnapshot> & {
  readonly toolCalls?: readonly ToolCallRecord[];
  readonly critique?: { readonly verdict?: string; readonly reason?: string; readonly improvement?: string };
};

const firstLine = (text: string | undefined): string => (text ?? "").split("\n").find((line) => line.trim() !== "")?.trim() ?? "";

/** The tool that failed: the last call the step made that did not complete. */
function failedTool(calls: readonly ToolCallRecord[]): ToolCallRecord | undefined {
  return [...calls].reverse().find((call) => call.status === "failed" || call.status === "blocked");
}

export interface StepObserverDeps {
  /** Absent means no failure channel; the provenance tagging still runs. */
  readonly brain?: Brain | undefined;
  /** The objective of the run an event belongs to, for the failure record. */
  readonly objectiveFor: (runId: string) => string | undefined;
  /** [C5] Records what one step's tool calls were derived from. */
  readonly tagStep: (runId: string, stepId: string, provenance: Provenance) => void;
}

/**
 * The run's event stream, read for the two things the store cannot tell a later prelude: which
 * steps failed, and what each step's tool calls were derived from. Synchronous and total — it
 * returns on anything it does not recognise and never throws into the bus.
 */
export function createStepObserver(deps: StepObserverDeps): (event: OrcEvent) => void {
  return (event) => {
    const step = event.step as StepFrame | undefined;
    if (!step?.id) return;
    const calls = step.toolCalls ?? [];
    if (calls.length > 0) deps.tagStep(event.runId, step.id, worstProvenance(calls.map(provenanceOf)));
    if (event.kind !== "step_end" && event.kind !== "step_blocked") return;
    const escalated = step.critique?.verdict === "escalate";
    const blocked = event.kind === "step_blocked" || step.status === "blocked";
    if (!blocked && !escalated && step.status !== "failed") return;
    const tool = failedTool(calls);
    const tags = [...(escalated ? ["critic_escalation"] : []), ...(blocked ? ["blocked"] : []), ...(tool ? [`tool_${tool.status}`] : [])];
    const reason =
      firstLine(step.critique?.reason) ||
      firstLine(step.critique?.improvement) ||
      firstLine(tool?.summary) ||
      firstLine(event.detail) ||
      firstLine(step.output) ||
      `the step ended ${step.status ?? event.kind}`;
    writeFailure(deps.brain, {
      objective: deps.objectiveFor(event.runId) ?? step.title ?? "",
      seat: step.agentRole ?? "unknown",
      ...(tool === undefined ? {} : { tool: tool.action.trim().split(/\s+/)[0] || tool.adapter }),
      ...(tags.length === 0 ? {} : { tags }),
      reason,
      runId: event.runId,
      stepId: step.id,
    });
  };
}

/** `- <ISO> [<writer> run <id>] [failure] <fields>` as `Brain.appendNote` renders it. */
const NOTE_RE = /^-\s+(\S+)\s+\[([^\]\s]+)(?:\s+run\s+([^\]]+))?\]\s+\[failure\]\s+(.+)$/;

function fieldsOf(rest: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of rest.split(FIELD_SEPARATOR)) {
    const colon = part.indexOf(":");
    if (colon === -1) continue;
    out[part.slice(0, colon).trim()] = part.slice(colon + 1).trim();
  }
  return out;
}

/** Every failure the brain holds, newest file first and newest line first within a file. */
export function readFailures(brain: Brain, limit = 200): RecalledFailure[] {
  const days = brain
    .tree()
    .filter((relative) => relative.startsWith(`${BRAIN_MEMORY_DIR}/`) && relative.endsWith(".md"))
    .sort()
    .reverse();
  const out: RecalledFailure[] = [];
  for (const day of days) {
    const body = brain.readFile(day);
    if (body === undefined) continue;
    for (const line of body.split("\n").reverse()) {
      const match = NOTE_RE.exec(line.trim());
      if (!match) continue;
      const fields = fieldsOf(match[4] ?? "");
      const tags = (fields.tags ?? "none") === "none" ? [] : (fields.tags ?? "").split(",").map((tag) => tag.trim()).filter(Boolean);
      out.push({
        at: match[1] ?? "",
        seat: fields.seat ?? match[2] ?? "",
        objective: fields.objective ?? "",
        tool: fields.tool ?? "none",
        tags,
        reason: fields.reason ?? "",
        runId: match[3]?.trim() || null,
        text: match[4] ?? "",
        score: 0,
      });
      if (out.length >= limit) return out;
    }
  }
  return out;
}

export interface FailureRecallInput {
  readonly brain: Brain;
  readonly objective: string;
  /** The run being prepared: its own failures are not recalled back to it. */
  readonly excludeRunId?: string;
  readonly config?: FleetMemoryConfig;
  readonly embed?: EmbedFn;
}

/**
 * The failures a seat about to work on this objective should see, ranked through the SAME seam as
 * cross-agent recall (`scoreAgainst` with the optional embedder), so a profile with no key gets
 * the lexical order and a profile with one gets the calibrated hybrid blend.
 */
export async function recallFailures(input: FailureRecallInput): Promise<FailureRecallResult> {
  const config = input.config ?? DEFAULT_FLEET_MEMORY_CONFIG;
  const candidates = readFailures(input.brain).filter((failure) => failure.runId === null || failure.runId !== input.excludeRunId);
  if (candidates.length === 0) return { block: "", chars: 0, items: [], dropped: 0 };

  const query = `${input.objective} ${deriveTaskType(input.objective).replace(/-/g, " ")}`;
  const scores = await scoreAgainst(query, candidates.map((failure) => `${failure.objective} ${failure.reason} ${failure.tool} ${failure.tags.join(" ")}`), input.embed);
  const related = candidates
    .map((failure, i) => ({ ...failure, score: scores[i] ?? 0 }))
    .filter((failure) => failure.score >= config.recallMinScore)
    .sort((a, b) => b.score - a.score || b.at.localeCompare(a.at));
  if (related.length === 0) return { block: "", chars: 0, items: [], dropped: 0 };

  const budget = Math.max(0, Math.trunc(config.recallBudgetChars * FAILURE_BUDGET_RATIO));
  const header = `## Failures other seats already hit (${FAILURE_MARKER} lines; what was tried and lost, so it is not tried again)`;
  const lines: string[] = [];
  const kept: RecalledFailure[] = [];
  let used = header.length;
  for (const failure of related) {
    const line = `- ${FAILURE_MARKER} ${failure.seat} | ${failure.objective} | tool ${failure.tool} | ${failure.reason}`;
    if (used + 1 + line.length > budget) continue;
    lines.push(line);
    used += 1 + line.length;
    kept.push(failure);
  }
  if (kept.length === 0) return { block: "", chars: 0, items: [], dropped: related.length };
  const block = `${header}\n${lines.join("\n")}`;
  return { block, chars: block.length, items: kept, dropped: related.length - kept.length };
}
