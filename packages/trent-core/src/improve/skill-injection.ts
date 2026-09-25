/**
 * The loop's output reaching a seat (task I.17).
 *
 * `apps/web/lib/orchestrator-runtime.ts:1437` injects a company's live skills into the seat prompt
 * only when `SKILL_INJECTION_ENABLED=1`, reads them from ITS store (the SkillDraft table in durable
 * mode, an empty in-memory store otherwise), and then discards the `skillApplied` signal
 * (`void skillApplied`, line 1467). So even with the flag on, the wrapper's trace never learns
 * whether a skill was in the prompt, and in in-memory mode nothing is injected at all.
 *
 * This module wraps the seat executor the orchestrator already accepts through its DI seam
 * (`createOrchestrator({ executeSeatModelFn })`): for every seat call it builds the prelude from
 * the wrapper's OWN live drafts for the agent running that seat, through the app's real
 * `buildCompanySkillPrelude`, prepends it unless the app already did (its header is present), and
 * remembers per step whether a skill reached the model. `createTraceWriter` reads that record, so
 * `skillApplied` on the trace is what actually happened, not a guess.
 *
 * The flag is honoured exactly as the app honours it: nothing is injected unless it is "1".
 * A failure to build the prelude leaves the prompt unchanged and the step unapplied.
 */

import { insertAfterStableTier } from "../fleet-memory/tiers.js"; // [P2-7]
import type { SkillDraftStore } from "../skills/foundry.js";
import type { ImproveStorePort } from "../store/StorePort.js";

/** First line of the app's prelude (`agent-skill-instructions.ts:buildCompanySkillPrelude`). */
export const SKILL_PRELUDE_MARKER = "# Reusable skills for this task";

export interface SeatCallLike {
  readonly companyId: string;
  readonly subtask: { readonly id: string; readonly seat: string; readonly objective?: string };
  readonly systemPrompt: string;
}

export interface SkillInjectorOptions {
  readonly store: ImproveStorePort;
  /** Maps a seat role to the agent that runs it (the plugged specialist, or the role). */
  readonly resolveAgentId?: (companyId: string, role: string) => Promise<string> | string;
  /** Defaults to `process.env.SKILL_INJECTION_ENABLED === "1"`, read at call time. */
  readonly enabled?: () => boolean;
  readonly maxSkills?: number;
  readonly onError?: (message: string) => void;
}

export interface SkillInjector {
  /** Wraps a seat executor so every call sees the agent's live skills. */
  seatModel<I extends SeatCallLike, R>(underlying: (input: I) => Promise<R>): (input: I) => Promise<R>;
  /** Whether a live skill reached the model on this step. Unknown steps are `false`. */
  appliedTo(stepId: string): boolean;
}

/** The app's `SkillDraftStore` over the wrapper's live drafts for ONE agent. Reads only. */
function liveDraftsFor(store: ImproveStorePort, agentId: string): SkillDraftStore {
  const live = (companyId: string, taskType?: string) =>
    store.listDrafts(companyId, { agentId, kind: "skill", status: "live", ...(taskType === undefined ? {} : { taskType }) });
  return {
    async writeQuarantine() {
      throw new Error("read-only: the seat never writes a draft");
    },
    async readQuarantine() {
      return undefined;
    },
    async promote() {
      throw new Error("read-only: promotion is a human command through lifecycle.ts");
    },
    async readLive(companyId, taskType) {
      return (await live(companyId, taskType))[0]?.content;
    },
    async listLiveTaskTypes(companyId) {
      return [...new Set((await live(companyId)).map((d) => d.taskType))];
    },
  };
}

export function createSkillInjector(options: SkillInjectorOptions): SkillInjector {
  const applied = new Map<string, boolean>();
  const enabled = options.enabled ?? (() => process.env.SKILL_INJECTION_ENABLED === "1");
  const resolveAgentId = options.resolveAgentId ?? ((_companyId: string, role: string) => role);

  async function preludeFor(input: SeatCallLike): Promise<string> {
    const agentId = await resolveAgentId(input.companyId, input.subtask.seat);
    const { buildCompanySkillPrelude } = await import("@/lib/agent-skill-instructions");
    // Relevance ranking reads the step's objective, as the app's `stepText` does; never logged.
    const stepText = input.subtask.objective ?? input.subtask.seat;
    const { prelude } = await buildCompanySkillPrelude(
      input.companyId,
      liveDraftsFor(options.store, agentId) as unknown as Parameters<typeof buildCompanySkillPrelude>[1],
      stepText,
      options.maxSkills ?? 2,
    );
    return prelude;
  }

  return {
    seatModel(underlying) {
      return async (input) => {
        if (!enabled()) return underlying(input);
        const stepId = input.subtask.id;
        if (input.systemPrompt.includes(SKILL_PRELUDE_MARKER)) {
          // The app injected from the shared SkillDraft table (durable mode). Record it, do not double up.
          applied.set(stepId, true);
          return underlying(input);
        }
        let prelude = "";
        try {
          prelude = await preludeFor(input);
        } catch (error) {
          options.onError?.(`skill prelude failed for step ${stepId}: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (prelude === "") {
          if (!applied.has(stepId)) applied.set(stepId, false);
          return underlying(input);
        }
        applied.set(stepId, true);
        // [P2-7] After the fleet-memory STABLE tier, never in front of it: that tier is the request's
        // provider-cacheable first bytes, and this prelude is ranked against the step.
        return underlying({ ...input, systemPrompt: insertAfterStableTier(input, prelude) });
      };
    },
    appliedTo(stepId) {
      return applied.get(stepId) ?? false;
    },
  };
}
