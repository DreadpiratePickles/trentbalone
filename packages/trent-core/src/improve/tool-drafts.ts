/**
 * [D5] item 2 — a tool over its health threshold becomes a gated proposal.
 *
 * The draft is a draft like any other: it lands in quarantine, it is refused before it is scored
 * if its bytes are vetoed or its write would land on the frozen surface, and the only door out is
 * `trent improve promote`, a human command. What is different is what it proposes. A skill draft
 * proposes something the agent will say; this proposes something the agent will READ — one tool's
 * description, and nothing else about that tool. The schema and the handler are code, and code is
 * not what the evidence is about: a tool whose arguments are refused a quarter of the time is a
 * tool whose description did not say what it wanted.
 *
 * A tool is not owned by one seat, so the drafts are held under {@link TOOL_DRAFT_AGENT} rather
 * than under whichever seat happened to call the tool most. The `taskType` is the tool name, so
 * one tool has one live override and `listDrafts` answers "what is live for this tool" directly.
 *
 * Offline the proposal is a deterministic template: it quotes the shipped description, states the
 * four measured rates and three redacted example refusals, and asks for a rewrite. That is a
 * proposal a human can act on without a model having been called, and it is the same bytes every
 * sweep, so the veto works. Live, the same evidence goes to the reflection model under the
 * sweep's meter and the model's answer is the proposed description.
 */

import type { ImproveStorePort, IterationRow, SkillDraftRow } from "../store/StorePort.js";
import { refuseBeforeScoring, type DraftGateContext } from "./draft-gates.js";
import { contentHash, newId } from "./ledger.js";
import { isBudgetExhausted } from "./meter.js";
import { toolHealth, toolsOverThreshold, type ToolHealth, type ToolHealthThresholds } from "./tool-health.js";
import type { AgentTraceRow } from "../store/StorePort.js";

/** The pseudo-agent tool drafts are held under: a tool belongs to the profile, not to a seat. */
export const TOOL_DRAFT_AGENT = "__tools__";
/** What put the draft there, recorded on the iteration exactly as a distill trigger is. */
export const TOOL_HEALTH_TRIGGER = "tool_health";
/**
 * Why a tool draft sits in quarantine. There is deliberately no executing gate here: a tool's
 * suite is its measured call history, and the decision a human makes is whether the new wording
 * describes the tool. Scoring a description against a seat's goldens would measure the seat.
 */
export const TOOL_REVIEW_BLOCK = "human_review";

export interface ToolDraftEvidence {
  readonly calls: number;
  readonly failures: number;
  readonly failureRate: number;
  readonly invalidArguments: number;
  readonly invalidArgumentRate: number;
  readonly retries: number;
  readonly retryRate: number;
  readonly meanArgsBytes: number;
  /** Redacted refusal texts, at most three (`tool-health.ts`). */
  readonly examples: readonly string[];
}

export interface ToolDraftPayload {
  readonly tool: string;
  readonly adapter?: string;
  /** The description as the code ships it, or the empty string when the caller could not resolve it. */
  readonly currentDescription: string;
  readonly proposedDescription: string;
  readonly evidence: ToolDraftEvidence;
}

/** Keys in a fixed order, so the same evidence always hashes to the same bytes (gate 5). */
export function encodeToolDraft(payload: ToolDraftPayload): string {
  return JSON.stringify(
    {
      tool: payload.tool,
      ...(payload.adapter === undefined ? {} : { adapter: payload.adapter }),
      currentDescription: payload.currentDescription,
      proposedDescription: payload.proposedDescription,
      evidence: {
        calls: payload.evidence.calls,
        failures: payload.evidence.failures,
        failureRate: payload.evidence.failureRate,
        invalidArguments: payload.evidence.invalidArguments,
        invalidArgumentRate: payload.evidence.invalidArgumentRate,
        retries: payload.evidence.retries,
        retryRate: payload.evidence.retryRate,
        meanArgsBytes: payload.evidence.meanArgsBytes,
        examples: [...payload.evidence.examples],
      },
    },
    null,
    2,
  );
}

export function decodeToolDraft(content: string): ToolDraftPayload | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const record = parsed as Partial<ToolDraftPayload>;
  if (typeof record.tool !== "string" || typeof record.proposedDescription !== "string" || record.evidence === undefined) return undefined;
  return record as ToolDraftPayload;
}

function evidenceOf(health: ToolHealth): ToolDraftEvidence {
  return {
    calls: health.calls,
    failures: health.failures,
    failureRate: health.failureRate,
    invalidArguments: health.invalidArguments,
    invalidArgumentRate: health.invalidArgumentRate,
    retries: health.retries,
    retryRate: health.retryRate,
    meanArgsBytes: health.meanArgsBytes,
    examples: [...health.examples],
  };
}

function evidenceLines(health: ToolHealth): string[] {
  return [
    `calls ${health.calls}`,
    `failure rate ${health.failureRate}`,
    `invalid-argument rate ${health.invalidArgumentRate} (${health.invalidArguments} of ${health.calls})`,
    `corrected re-call rate ${health.retryRate} (${health.retries} of ${health.calls})`,
    `mean argument size ${health.meanArgsBytes} bytes`,
  ];
}

function describedAs(current: string): string {
  return current === "" ? "(the sweep could not resolve the shipped description)" : current;
}

/** The reflection prompt, live. The evidence is the whole of it; nothing else is sent. */
export function toolProposalPrompt(health: ToolHealth, currentDescription: string): string {
  return [
    `The tool "${health.tool}" is described to the model as:`,
    "",
    describedAs(currentDescription),
    "",
    "Its measured call history says the description is not telling the model what the tool wants:",
    ...evidenceLines(health).map((line) => `- ${line}`),
    ...(health.examples.length === 0 ? [] : ["", "Refusals it produced, redacted:", ...health.examples.map((example) => `- ${example}`)]),
    "",
    "Rewrite the description so a model reading it alone supplies correct arguments the first time.",
    "Name each argument it takes, its type, and the values it refuses. Keep it under 80 words.",
    "Reply with the description alone: no preamble, no quotes, no markdown fence.",
  ].join("\n");
}

/**
 * The offline proposal: the evidence, the shipped description, and the rewrite request — as a
 * proposal a human reads, not as a rewrite a template pretended to make. Deterministic, so the
 * same evidence proposed twice is the same bytes and gate 5 can refuse the second.
 */
export function offlineToolProposal(health: ToolHealth, currentDescription: string): string {
  return [
    `Rewrite the description of "${health.tool}".`,
    "",
    "Shipped description:",
    describedAs(currentDescription),
    "",
    "Measured over this profile's traces:",
    ...evidenceLines(health).map((line) => `- ${line}`),
    ...(health.examples.length === 0 ? [] : ["", "Refusals, redacted:", ...health.examples.map((example) => `- ${example}`)]),
    "",
    "A rewrite must name every argument, its type and the values the tool refuses. No model was",
    "called for this proposal: the sweep ran offline, so the evidence is the proposal.",
  ].join("\n");
}

/** Live: the reflection model, metered by the caller. Text, or text with the cents it cost. */
export type ToolProposeFn = (prompt: string) => Promise<string | { text: string; costCents: number }>;

export interface ProposeToolDraftsInput {
  readonly store: ImproveStorePort;
  readonly companyId: string;
  /** The traces the sweep already read. */
  readonly rows: readonly AgentTraceRow[];
  /** [D0] gates 1 and 5, shared with every other draft in this sweep. */
  readonly gates: DraftGateContext;
  readonly now: string;
  /** The shipped description of a tool, when the caller can resolve one (`tools/index.ts`). */
  readonly descriptionFor?: (tool: string) => string | undefined;
  /** Omit for the deterministic template; pass the metered reflection model for `--live`. */
  readonly propose?: ToolProposeFn;
  readonly thresholds?: ToolHealthThresholds;
}

export interface ToolProposalRow {
  readonly tool: string;
  readonly draftId: string;
  readonly decision: string;
  readonly blockedBy: string | null;
}

export interface ToolProposalReport {
  /** Every tool measured, over the threshold or not, so a sweep report can show the signal. */
  readonly health: readonly ToolHealth[];
  readonly proposed: readonly ToolProposalRow[];
  readonly skipped: ReadonlyArray<{ tool: string; reason: string }>;
  readonly errors: readonly string[];
}

async function proposalText(input: ProposeToolDraftsInput, health: ToolHealth, current: string): Promise<string> {
  if (!input.propose) return offlineToolProposal(health, current);
  const answer = await input.propose(toolProposalPrompt(health, current));
  const text = (typeof answer === "string" ? answer : answer.text).trim();
  return text === "" ? offlineToolProposal(health, current) : text;
}

/** What a caller gives the sweep for the tool pass; every field has a documented default. */
export interface SweepToolOptions {
  /**
   * The shipped description of a tool, for the proposal to quote. Omit and the proposal says it
   * could not be resolved rather than inventing one.
   */
  readonly descriptionFor?: (tool: string) => string | undefined;
  /** The reflection model that writes the description. Ignored while the sweep is offline. */
  readonly propose?: ToolProposeFn;
  /** `tool_health_threshold` (0.2) and `tool_health_min_calls` (20) when the defaults are wrong. */
  readonly thresholds?: ToolHealthThresholds;
}

/** The slice of the sweep's run context this pass reads. `SweepRunContext` satisfies it. */
export interface SweepToolRun {
  readonly deps: { readonly store: ImproveStorePort; readonly skipLLM?: boolean; readonly toolProposals?: SweepToolOptions };
  readonly gates: DraftGateContext;
  readonly now: string;
  /** The sweep's meter: a live proposal is a reflection call, counted and capped like GEPA's. */
  readonly meter: { reflect: (inner: ToolProposeFn) => ToolProposeFn };
}

/**
 * [D5] The sweep's tool pass: once per sweep, over every trace in scope rather than once per
 * agent, because a tool belongs to the profile — one tool over its threshold is one proposal
 * however many seats called it.
 */
export async function sweepToolProposals(companyId: string, rows: readonly AgentTraceRow[], run: SweepToolRun): Promise<ToolProposalReport> {
  const options = run.deps.toolProposals ?? {};
  const offline = run.deps.skipLLM ?? true;
  const propose = options.propose === undefined || offline ? undefined : run.meter.reflect(options.propose);
  return proposeToolDrafts({
    store: run.deps.store,
    companyId,
    rows,
    gates: run.gates,
    now: run.now,
    ...(options.descriptionFor === undefined ? {} : { descriptionFor: options.descriptionFor }),
    ...(propose === undefined ? {} : { propose }),
    ...(options.thresholds === undefined ? {} : { thresholds: options.thresholds }),
  });
}

/**
 * One pass over the sweep's traces: measure every tool, draft for the ones over the threshold,
 * and put each draft through the pre-scoring gates. Never throws — a failure for one tool is
 * reported and the next tool is still measured.
 */
export async function proposeToolDrafts(input: ProposeToolDraftsInput): Promise<ToolProposalReport> {
  const health = toolHealth(input.rows);
  const proposed: ToolProposalRow[] = [];
  const skipped: Array<{ tool: string; reason: string }> = [];
  const errors: string[] = [];

  for (const tool of toolsOverThreshold(health, input.thresholds ?? {})) {
    try {
      const current = input.descriptionFor?.(tool.tool) ?? "";
      const content = encodeToolDraft({
        tool: tool.tool,
        ...(tool.adapter === undefined ? {} : { adapter: tool.adapter }),
        currentDescription: current,
        proposedDescription: await proposalText(input, tool, current),
        evidence: evidenceOf(tool),
      });
      const hash = contentHash(content);
      const existing = await input.store.listDrafts(input.companyId, { agentId: TOOL_DRAFT_AGENT, taskType: tool.tool, kind: "tool" });
      if (existing.some((draft) => draft.contentHash === hash && (draft.status === "quarantine" || draft.status === "live"))) {
        skipped.push({ tool: tool.tool, reason: "unchanged" });
        continue;
      }
      const draft: SkillDraftRow = {
        id: newId("tool"),
        companyId: input.companyId,
        agentId: TOOL_DRAFT_AGENT,
        taskType: tool.tool,
        kind: "tool",
        status: "quarantine",
        content,
        contentHash: hash,
        triggers: [TOOL_HEALTH_TRIGGER],
        createdAt: input.now,
        promotedAt: null,
        lastUsedAt: null,
        retiredAt: null,
      };
      await input.store.createDraft(draft);
      const refused = await refuseBeforeScoring(input.gates, draft);
      const iteration: IterationRow = {
        id: newId("iter"),
        companyId: input.companyId,
        agentId: TOOL_DRAFT_AGENT,
        taskType: tool.tool,
        candidateId: draft.id,
        candidateKind: "tool",
        score: null,
        delta: null,
        decision: refused?.decision ?? "quarantined",
        triggers: [TOOL_HEALTH_TRIGGER],
        blockedBy: refused?.blockedBy ?? TOOL_REVIEW_BLOCK,
        inputHash: hash,
        verdicts: refused?.verdicts ?? null,
        createdAt: input.now,
      };
      await input.store.appendIteration(iteration);
      proposed.push({ tool: tool.tool, draftId: draft.id, decision: iteration.decision, blockedBy: refused?.blockedBy ?? null });
    } catch (error) {
      // A proposal the meter could not afford is not a proposal that failed: the sweep stops
      // asking, exactly as a draft it could not afford to gate stays in quarantine (gate 7).
      if (isBudgetExhausted(error)) {
        skipped.push({ tool: tool.tool, reason: "budget_exhausted" });
        break;
      }
      errors.push(`tool[${tool.tool}]: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { health, proposed, skipped, errors };
}
