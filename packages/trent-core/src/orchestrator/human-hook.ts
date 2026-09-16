/**
 * The orchestrator side of `ask_human` (`../tools/human`): the two things the tool cannot know
 * on its own.
 *
 *   1. Whether the seat calling it is a delegated child. The seat executor is wrapped the way the
 *      fleet-memory hook wraps it, and the `[delegated]` objective rule (`fleet-memory/source.ts`)
 *      is bound into the adapter's caller context, so a child's `ask_human` is `blocked` instead
 *      of parking a run the parent's tool loop could never resume.
 *   2. The founder's answer. `answer(runId, stepId, text, release)` stores the text where the
 *      adapter's replay reads it (`HumanAnswers`, keyed by run and step) and then releases the
 *      parked step through the existing `approve`: the same waiter, the same app resume path.
 */
import { isDelegatedObjective } from "../fleet-memory/source.js";
import { HUMAN_ADAPTER_NAME, sharedHumanAnswers, type HumanAdapter, type HumanAnswers } from "../tools/human/index.js";
import type { TrentToolAdapter } from "../tools/types.js";
import type { SeatModelFn } from "./seat-guard.js";

export type ReleaseStep = (runId: string, stepId: string) => Promise<boolean>;

export interface HumanHook {
  /** Wraps the seat executor so the adapter knows whether the calling step is delegated. */
  wrapSeatModel(fn: SeatModelFn): SeatModelFn;
  /** Stores the answer for the replay, then releases the step. */
  answer(runId: string, stepId: string, text: string, release: ReleaseStep): Promise<boolean>;
}

function isHumanAdapter(adapter: TrentToolAdapter): adapter is HumanAdapter {
  return adapter.name === HUMAN_ADAPTER_NAME && typeof (adapter as Partial<HumanAdapter>).bindCallerContext === "function";
}

export function createHumanHook(tools: readonly TrentToolAdapter[], answers: HumanAnswers = sharedHumanAnswers): HumanHook {
  const adapter = tools.find(isHumanAdapter);
  let delegated = false;
  adapter?.bindCallerContext(() => ({ delegated }));
  return {
    wrapSeatModel(fn) {
      if (adapter === undefined) return fn;
      return async (input) => {
        const objective = (input.subtask as { objective?: string }).objective ?? "";
        delegated = isDelegatedObjective(objective);
        return fn(input);
      };
    },
    async answer(runId, stepId, text, release) {
      answers.put(runId, stepId, text);
      return release(runId, stepId);
    },
  };
}
