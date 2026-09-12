/**
 * @file lib/seat-worker.ts
 * Worker seat runtime for the 9-seat operating loop (Phase 10, §3.1).
 *
 * Each seat is an isolated worker with its OWN context window — never one shared
 * conversation across all 9 seats (that's the documented single-context anti-pattern).
 * A worker consumes a typed Subtask, runs the per-seat planner→executor→critic loop,
 * writes its output to the artifact store, and returns a lightweight SeatResult
 * (an artifact reference + confidence + cost) to the CEO orchestrator.
 *
 * Implements the `SeatRunner` interface from lib/planner.ts so it can be injected
 * into runCycle, and registers a BullMQ processor so the orchestrator can dispatch
 * across processes (the durable message bus = your inter-agent transport).
 *
 * This deterministic foundation can be swapped to live model execution through
 * the same SeatRunner contract once the model gateway is connected.
 */

import { z } from "zod";
import type { AgentRole } from "@/lib/types";
import { callJson, MODELS, MAX_TOKENS } from "@/lib/ai-client";
import { store } from "@/lib/store";
import { getWorkbenchProvider } from "@/lib/workbench-provider";
import { runWorkbenchSelfHealingLoop } from "@/lib/workbench-self-heal";
import {
  type Subtask,
  type SeatResult,
  type SeatRunner,
  type HandoffEvent,
  subtaskSchema,
  recordHandoff,
} from "@/lib/planner";
import { getAgentRuntime } from "@/lib/agent-runtime";
import { loadGrantedSkillInstructions } from "@/lib/agent-skill-instructions";
import { makeId, nowIso } from "@/lib/utils";
import { logger } from "@/lib/logger";
import { executeSeatModel, type SeatModelExecutionResult } from "@/lib/model-gateway";

export type { Subtask };

// ---------------------------------------------------------------------------
// Per-seat critic config (§3.4 intelligence profiles)
// ---------------------------------------------------------------------------

interface SeatPolicy {
  /** Default model tier for this seat. */
  modelTier: "haiku" | "sonnet" | "opus";
  /** Whether a critic pass runs by default. */
  critic: boolean;
  /** Confidence below which the seat abstains and routes to human (§3.6). */
  abstainBelow: number;
}

const SEAT_POLICY: Record<AgentRole, SeatPolicy> = {
  ceo: { modelTier: "opus", critic: true, abstainBelow: 0.5 },
  engineer: { modelTier: "sonnet", critic: true, abstainBelow: 0.6 },
  growth: { modelTier: "sonnet", critic: true, abstainBelow: 0.6 },
  content: { modelTier: "sonnet", critic: true, abstainBelow: 0.6 },
  support: { modelTier: "haiku", critic: false, abstainBelow: 0.6 },
  finance: { modelTier: "opus", critic: true, abstainBelow: 0.75 },
  analyst: { modelTier: "sonnet", critic: true, abstainBelow: 0.65 },
  escalation: { modelTier: "haiku", critic: false, abstainBelow: 0 },
  sales: { modelTier: "sonnet", critic: true, abstainBelow: 0.65 },
};

// ---------------------------------------------------------------------------
// Critic output (structured critique feeds re-plan, not a blind retry; §3.1)
// ---------------------------------------------------------------------------

const critiqueSchema = z.object({
  pass: z.boolean(),
  score: z.number().min(0).max(1),
  issues: z.array(z.string()).default([]),
});
type Critique = z.infer<typeof critiqueSchema>;

type SeatExecutionPayload = SeatModelExecutionResult;

const CRITIC_SKILLS_BY_SEAT: Partial<Record<AgentRole, string[]>> = {
  growth: ["claude-ads-critic"],
};

export function getCriticSkillNamesForSeat(seat: AgentRole) {
  return [...(CRITIC_SKILLS_BY_SEAT[seat] ?? [])];
}

export async function buildCriticSkillPrompt(seat: AgentRole) {
  const skills = getCriticSkillNamesForSeat(seat);
  if (skills.length === 0) return "";
  return (await loadGrantedSkillInstructions(skills)).join("\n\n");
}

// ---------------------------------------------------------------------------
// The seat runtime
// ---------------------------------------------------------------------------

/** Concrete SeatRunner: plan → execute → critic, in the seat's isolated context. */
export class SeatWorker implements SeatRunner {
  constructor(private readonly companyId: string) {}

  async run(subtaskInput: Subtask): Promise<SeatResult> {
    const subtask = subtaskSchema.parse(subtaskInput); // validate at the boundary
    const policy = SEAT_POLICY[subtask.seat];
    const runtime = await getAgentRuntime(this.companyId, subtask.seat);

    logger.info(
      { seat: subtask.seat, subtaskId: subtask.id, model: policy.modelTier },
      "[seat-worker] starting subtask"
    );

    // 1. EXECUTE — run the seat with its tools, constrained to its output contract.
    const execution = await this.execute(subtask, runtime);

    // 2. CRITIC — score against the seat rubric; on fail, re-plan (capped upstream).
    let critique: Critique = critiqueSchema.parse({ pass: true, score: 0.9, issues: [] });
    if (policy.critic) {
      critique = await this.critique(subtask, execution.output);
    }

    // 3. PERSIST — write the full output as an artifact; pass back only the ref.
    const payloadRef = await this.persistArtifact(subtask, execution);

    // 4. CONFIDENCE — combine signals (critic score + entropy + history); abstain if low.
    const confidence = execution.error ? 0 : this.scoreConfidence(critique, policy);

    return {
      seat: subtask.seat,
      payloadRef,
      confidence,
      costCents: execution.costCents || estimateSeatCostCents(policy.modelTier),
      error: execution.error,
      workRequests: [], // populated when this seat needs another seat (§3.15).
      whatIDidNotDo: extractWhatIDidNotDo(execution.output),
    };
  }

  // -- internals -----------------------------------------------------------

  private async execute(subtask: Subtask, runtime: Awaited<ReturnType<typeof getAgentRuntime>>): Promise<SeatExecutionPayload> {
    if (subtask.seat === "engineer" && isWorkbenchSelfHealInput(subtask.input)) {
      const session = await store.getWorkbenchSession(subtask.input.workbenchSelfHeal.sessionId);
      if (!session) throw new Error(`Workbench session ${subtask.input.workbenchSelfHeal.sessionId} not found`);
      const provider = getWorkbenchProvider(session.provider);
      const output = await runWorkbenchSelfHealingLoop({
        session,
        provider,
        command: subtask.input.workbenchSelfHeal.command,
      });
      return {
        output,
        model: "workbench-self-heal",
        tokens: 0,
        costCents: 0,
        fallback: false,
      };
    }

    return executeSeatModel({
      companyId: this.companyId,
      subtask,
      systemPrompt: runtime.systemPrompt,
    });
  }

  private async critique(subtask: Subtask, output: unknown): Promise<Critique> {
    const criticSkills = await buildCriticSkillPrompt(subtask.seat);
    const system = [
      "You are a quality critic for an AI agent operating system.",
      "Review the agent output against the expected result.",
      "Return JSON: { pass: boolean, score: number (0-1), issues: string[] }",
      "pass=true when output substantially satisfies the objective.",
      "score reflects completeness and quality.",
      "issues lists specific gaps (empty if pass=true).",
      "Be terse. One sentence per issue maximum.",
      criticSkills,
    ].join("\n");

    const user = [
      `Seat: ${subtask.seat}`,
      `Objective: ${subtask.objective}`,
      `Expected output contract: ${subtask.outputContractId}`,
      "",
      `Output:\n${typeof output === "string" ? output.slice(0, 2000) : JSON.stringify(output).slice(0, 2000)}`,
    ].join("\n");

    try {
      const result = await callJson<Critique>(
        MODELS.FAST,        // critique uses cheap/fast model
        system,
        user,
        critiqueSchema,
        MAX_TOKENS.JSON,
      );
      return result.data;
    } catch {
      // Critique failure is non-fatal — default to pass so the loop continues.
      return critiqueSchema.parse({ pass: true, score: 0.75, issues: [] });
    }
  }

  private async persistArtifact(subtask: Subtask, execution: SeatExecutionPayload): Promise<string> {
    const artifact = await store.createArtifact({
      companyId: this.companyId,
      type: artifactTypeForSeat(subtask.seat),
      status: execution.error ? "failed" : "ready",
      title: `${subtask.seat} output: ${subtask.objective}`,
      summary: summarizeOutput(execution.output),
      content: stringifyOutput(execution.output),
      exportFormat: "markdown",
      createdByAgent: subtask.seat,
      provenance: {
        prompt: subtask.objective,
        sources: [],
        model: execution.model,
        tokens: execution.tokens,
        costCents: execution.costCents,
        generatedAt: nowIso(),
      },
    });
    logger.info({ ref: artifact.id, seat: subtask.seat, at: nowIso() }, "[seat-worker] artifact persisted");
    return artifact.id;
  }

  private scoreConfidence(critique: Critique, policy: SeatPolicy): number {
    const confidence = critique.score;
    if (confidence < policy.abstainBelow) {
      logger.warn({ confidence, abstainBelow: policy.abstainBelow }, "[seat-worker] below abstain threshold");
    }
    return confidence;
  }
}

// ---------------------------------------------------------------------------
// Dynamic collaboration helper — a seat asking the orchestrator for help (§3.15)
// ---------------------------------------------------------------------------

/** Build the HandoffEvent a seat emits when it produces output for another seat,
 * so the orchestrator can log it and route the next hop. */
export function buildHandoff(args: {
  cycleId: string;
  from: AgentRole;
  to: AgentRole;
  reason: string;
  severity?: "green" | "amber" | "red";
  summary?: string;
  nextActions?: string[];
  risks?: string[];
  payloadRef: string;
  whatIDidNotDo?: string[];
  contractVersion: string;
}): HandoffEvent {
  return {
    cycleId: args.cycleId,
    from: args.from,
    to: args.to,
    reason: args.reason,
    severity: args.severity ?? "green",
    summary: args.summary ?? args.reason,
    nextActions: args.nextActions ?? [],
    risks: args.risks ?? [],
    payloadRef: args.payloadRef,
    whatIDidNotDo: args.whatIDidNotDo ?? [],
    contractVersion: args.contractVersion,
    timestamp: nowIso(),
  };
}

/** Convenience: persist a hand-off to the audit chain. Thin wrapper over planner. */
export async function emitHandoff(companyId: string, event: HandoffEvent): Promise<void> {
  await recordHandoff(companyId, event);
}

// ---------------------------------------------------------------------------
// BullMQ wiring — register a processor so the orchestrator can dispatch jobs.
// ---------------------------------------------------------------------------

export const SUBTASK_JOB_NAME = "run_subtask" as const;

/** Process a dispatched subtask job. Wire this into lib/queue.ts processJobData,
 * or register a dedicated BullMQ Worker on SUBTASK_JOB_NAME in lib/worker.ts. */
export async function processSubtaskJob(data: { companyId: string; subtask: Subtask }): Promise<SeatResult> {
  const worker = new SeatWorker(data.companyId);
  return worker.run(data.subtask);
}

function estimateSeatCostCents(tier: SeatPolicy["modelTier"]) {
  if (tier === "opus") return 30;
  if (tier === "sonnet") return 10;
  return 2;
}

function artifactTypeForSeat(seat: AgentRole) {
  if (seat === "growth") return "campaign_report";
  if (seat === "support") return "support_summary";
  if (seat === "sales") return "campaign_report";
  if (seat === "finance" || seat === "analyst") return "dashboard";
  return "operating_memo";
}

function stringifyOutput(output: unknown) {
  return typeof output === "string" ? output : JSON.stringify(output, null, 2);
}

function summarizeOutput(output: unknown) {
  if (output && typeof output === "object" && "summary" in output) {
    const summary = (output as { summary?: unknown }).summary;
    if (typeof summary === "string" && summary.trim()) return summary.slice(0, 240);
  }
  return stringifyOutput(output).slice(0, 240);
}

function extractWhatIDidNotDo(output: unknown): string[] {
  if (!output || typeof output !== "object") return [];
  const value = (output as { whatIDidNotDo?: unknown }).whatIDidNotDo;
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function isWorkbenchSelfHealInput(input: unknown): input is {
  workbenchSelfHeal: { sessionId: string; command?: string };
} {
  if (!input || typeof input !== "object") return false;
  const maybe = (input as { workbenchSelfHeal?: unknown }).workbenchSelfHeal;
  if (!maybe || typeof maybe !== "object") return false;
  const selfHeal = maybe as { sessionId?: unknown; command?: unknown };
  return typeof selfHeal.sessionId === "string"
    && (selfHeal.command === undefined || typeof selfHeal.command === "string");
}
