/**
 * The planner/critic port tally and the wrapper-side consolidator.
 *
 * Finding 1 of the live proof (04_verification/output/live-agents-and-tools.md): with a Gemini-only
 * key the planner, the critic and the consolidator never reached the provider. The planner and the
 * critic DO have an injection seam — `runtime-eval-overrides.orchestration.createCompletion`, read
 * by `callJsonWithFallback` (planner) and `callCriticJsonWithRepair` (critic) — so the wrapper
 * installs the gateway-backed port there (`../model-gateway/completion-port.ts`). The consolidator
 * has NO seam: `consolidateRun` -> `callTextWithFallback` -> `callText(model, system, user,
 * maxTokens)`, which takes no options and reads `OPENAI_API_KEY` directly. `apps/web` is read-only,
 * so the wrapper recognises the literal fallback summary on `consolidate_end` and produces the real
 * brief itself, through the same gateway, from the step outputs.
 *
 * The tally also closes the "never silent" gap: `callJsonWithFallback` swallows a planner failure
 * and returns the canned plan. With a provider configured that is an error, not a plan, so the
 * wrapper records what the port saw and fails the run on `plan_end` when the plan is the fallback
 * and the port reported a real (non-offline) failure.
 */

import type { CompletionPortCall } from "../model-gateway/completion-port.js";
import type { ModelGateway } from "../model-gateway/types.js";
import { FALLBACK_PLAN_REASONING, FALLBACK_RUN_SUMMARY, type OrcEvent } from "./types.js";

/** Which pipeline phase a port call belongs to; the wrapper advances it on `plan_end`. */
export type PortPhase = "planning" | "executing";

/** What the planner/critic port observed for one run. */
export class PortTally {
  #phase: PortPhase = "planning";
  #plannerError: string | undefined;
  #plannerOffline = false;
  #criticFailures: string[] = [];
  #calls = 0;

  get calls(): number {
    return this.#calls;
  }

  /** Called by the wrapper on `plan_end`: every later port call is a critic call. */
  enterExecution(): void {
    this.#phase = "executing";
  }

  /** [L1] True after `plan_end`: a port call now is the critic's (`port-escalation.ts`). */
  get executing(): boolean {
    return this.#phase === "executing";
  }

  record(call: CompletionPortCall): void {
    this.#calls += 1;
    if (call.ok) return;
    if (this.#phase === "planning") {
      this.#plannerError = call.error ?? "planner call failed";
      this.#plannerOffline = call.offline;
      return;
    }
    if (!call.offline) this.#criticFailures.push(call.error ?? "critic call failed");
  }

  /**
   * The provider's message when the planner call failed with a provider configured. Undefined when
   * it succeeded or when there is no provider at all (offline mode keeps the deterministic plan).
   */
  plannerFailure(): string | undefined {
    if (this.#plannerError === undefined || this.#plannerOffline) return undefined;
    return this.#plannerError;
  }

  criticFailures(): readonly string[] {
    return this.#criticFailures;
  }
}

/** The slice of the live run the consolidator reads. */
export interface ConsolidationInput {
  readonly objective: string;
  readonly successCriteria?: readonly string[];
  readonly steps: ReadonlyArray<{
    readonly title: string;
    readonly agentRole?: string;
    readonly status: string;
    readonly output?: string;
  }>;
}

/** Same brief format `consolidateRun` asks for, so surfaces render it identically. */
const CONSOLIDATOR_SYSTEM = [
  "You are the consolidator. Write a final brief that a founder can read in 60 seconds and act on.",
  "Format:",
  "  TL;DR — one sentence.",
  "  WHAT SHIPPED — 2-4 bullets.",
  "  RISKS / BLOCKERS — bullets, or 'none'.",
  "  ↗ NEXT ACTION — a single direct ask.",
  "Plain text only. Do not wrap the brief in JSON or markdown fences.",
].join("\n");

export function buildConsolidationPrompt(input: ConsolidationInput): string {
  const completed = input.steps.filter((step) => step.status === "completed");
  const failed = input.steps.filter((step) => step.status === "failed");
  return [
    `Objective: ${input.objective}`,
    input.successCriteria?.length ? `Success criteria: ${input.successCriteria.join("; ")}` : "",
    "",
    `Completed (${completed.length}):`,
    ...completed.map((step) => `- ${step.title} [${step.agentRole ?? "seat"}]: ${(step.output ?? "").slice(0, 1200)}`),
    failed.length ? `\nFailed (${failed.length}):\n${failed.map((step) => `- ${step.title}: ${(step.output ?? "").slice(0, 300)}`).join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** True when the summary is the pipeline's fallback literal (optionally with the app's suffixes). */
export function isFallbackSummary(summary: string | undefined): boolean {
  if (summary === undefined) return false;
  return summary.trim().startsWith(FALLBACK_RUN_SUMMARY);
}

/**
 * Produces the founder brief through the gateway. Throws on a provider failure; the caller decides
 * whether to keep the literal (and says so in the event detail).
 */
export async function consolidateWithGateway(gateway: ModelGateway, input: ConsolidationInput, maxTokens = 1024): Promise<string> {
  if (gateway.configuredProviders().length === 0) {
    throw new Error("model provider is not configured: no API key found");
  }
  const completion = await gateway.complete({
    role: "executor",
    messages: [
      { role: "system", content: CONSOLIDATOR_SYSTEM },
      { role: "user", content: buildConsolidationPrompt(input) },
    ],
    maxTokens,
    temperature: 0.4,
  });
  const text = completion.text.trim();
  if (text === "") throw new Error(`${completion.model} returned empty text`);
  return text;
}

// --- Event shaping driven by the ports ------------------------------------------------------------

/** What the shaper needs from the wrapper: the live run to consolidate from, and where to write. */
export interface PortShaperHost {
  readonly objective: string;
  liveRun(): (ConsolidationInput & { readonly plan?: { objective: string; successCriteria?: string[] } }) | undefined;
  /** Writes the consolidated brief where the snapshot and the store read it. */
  persistSummary(summary: string): Promise<void>;
}

export const WRAPPER_CONSOLIDATED_DETAIL =
  "wrapper consolidated through the model gateway: the pipeline's consolidator has no provider seam " +
  "and returned its fallback literal.";

/**
 * Rewrites bus events in the light of the planner/critic port and the wrapper consolidator. Runs
 * BEFORE the seat guard's `shapeEvent`. Async because the consolidation is a provider call, so the
 * wrapper serialises events through it.
 */
export class PortShaper {
  fallbackPlan = false;
  /** Set on `plan_end` when the canned plan stands in for a provider failure; stops the drain. */
  plannerFailure: string | undefined;
  /** The wrapper's brief, once produced; also stamped on `run_done`. */
  consolidated: string | undefined;

  constructor(
    readonly ports: PortTally,
    private readonly gateway: ModelGateway,
    private readonly host: PortShaperHost,
  ) {}

  async shape(event: OrcEvent): Promise<OrcEvent | undefined> {
    switch (event.kind) {
      case "plan_end": {
        if (event.run?.plan?.reasoning === FALLBACK_PLAN_REASONING) this.fallbackPlan = true;
        this.ports.enterExecution();
        const failure = this.fallbackPlan ? this.ports.plannerFailure() : undefined;
        if (failure === undefined) return event;
        // The canned plan is not a plan: the drain loop stops at settle() and run_failed follows.
        this.plannerFailure = failure;
        return undefined;
      }
      case "consolidate_end": {
        if (!isFallbackSummary(event.run?.summary)) return event;
        const live = this.host.liveRun();
        try {
          const summary = await consolidateWithGateway(this.gateway, {
            objective: live?.plan?.objective ?? live?.objective ?? this.host.objective,
            successCriteria: live?.plan?.successCriteria,
            steps: live?.steps ?? [],
          });
          this.consolidated = summary;
          await this.host.persistSummary(summary);
          return { ...event, run: { ...event.run, summary }, detail: WRAPPER_CONSOLIDATED_DETAIL };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return { ...event, detail: `wrapper consolidation unavailable (${message}); kept the pipeline's fallback summary.` };
        }
      }
      case "run_done":
      case "run_failed": {
        let shaped = event;
        if (this.consolidated !== undefined) shaped = { ...shaped, run: { ...shaped.run, summary: this.consolidated } };
        const critic = this.ports.criticFailures();
        if (critic.length > 0) {
          const note = `critic call failed ${critic.length} time(s); last: ${critic[critic.length - 1]}`;
          shaped = { ...shaped, detail: shaped.detail ? `${shaped.detail}; ${note}` : note };
        }
        return shaped;
      }
      default:
        return event;
    }
  }

  /** The `run_failed` frame emitted in the canned plan's place. */
  plannerFailedEvent(runId: string, summary: string, completedAt: string): OrcEvent {
    return {
      kind: "run_failed",
      runId,
      at: completedAt,
      detail: `planner call failed: ${this.plannerFailure ?? "planner call failed"}`,
      run: { id: runId, status: "failed", summary, completedAt },
    };
  }
}
