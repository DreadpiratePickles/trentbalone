/**
 * [S2] The solo memory port over the fleet's OWN tier builders.
 *
 * `createFleetMemoryHook` (`fleet-memory/orchestrator-hook.ts`) assembles the injection a seat gets:
 * STABLE (company memory, the brain, the workspace, the org skills index), CONTEXT (this seat's
 * skills, recall from the brain, cross-run recall, the failures channel) and VOLATILE (the
 * personality suffix). Solo reuses exactly that assembly through the hook's public door, as seat
 * `trent`: the run is declared, one seat call is made whose model is a no-op, and the kept blocks
 * are read back with `contextFor`. Nothing is re-implemented, so solo sees what a seat sees.
 *
 * Three differences, all deliberate ([CF] the third):
 *   - the brain block is rendered again WITHOUT `system/solo.md`: that file is the persona the solo
 *     runner already puts at the head of its system prompt (`prompt.ts`), and the brain block
 *     renders `system/` in full, so the persona would be paid for twice (S1 follow-up 1). The tree
 *     still names the file; only its body stays out of the brain block.
 *   - the `stable-version` line is dropped: the solo prefix is frozen per session, so a hash of a
 *     later stable tier would describe bytes this session's prompt does not carry.
 *   - [CF] C15.1 the memory section is worded for one person: "## Your memory", the blocks in solo's words
 *     (`MemoryAdapter.snapshotFor("solo")`: no seat, no founder). The hook's own heading and snapshot are the
 *     fleet's, byte for byte; one hook serves both modes, so solo re-renders its copy here.
 * Volatile blocks travel with the context tier, after the history, as they do for a seat.
 */
import { createBrain } from "../fleet-memory/brain.js";
import { brainSystemFileFor } from "../fleet-memory/brain-migrate.js";
import { renderBrainBlock } from "../fleet-memory/brain-prompt.js";
import type { FleetMemoryHook } from "../fleet-memory/orchestrator-hook.js";
import { CONTEXT_BLOCKS, type ContextBlock } from "../fleet-memory/tiers.js";
import { SOLO_PERSONA_FILE } from "./prompt.js";
import { SOLO_SEAT, type SoloMemory } from "./types.js";

export interface FleetMemoryPortOptions {
  readonly hook: FleetMemoryHook;
  readonly companyId: string;
  /** The profile the brain lives in. Absent, the brain block is passed on as the hook rendered it. */
  readonly profileDir?: string;
}

/** [CF] C15.1 The heading of the memory section in a solo prompt (the fleet's: "## Company memory (shared by every seat; ...)"). */
export const SOLO_MEMORY_HEADING = "## Your memory (as it stood when this conversation opened; what you save shows from the next conversation on)";

/** [CF] The memory section in solo's words, when the hook's adapter can render them; any other block unchanged. */
function inSoloWords(block: ContextBlock, options: FleetMemoryPortOptions): ContextBlock {
  if (block.name !== CONTEXT_BLOCKS.companyMemory) return block;
  const snapshotFor = (options.hook.memory as { snapshotFor?: (mode: "solo") => string }).snapshotFor;
  return typeof snapshotFor === "function" ? { ...block, text: `${SOLO_MEMORY_HEADING}\n${snapshotFor.call(options.hook.memory, "solo")}` } : block;
}

/** The brain block again, without the persona's body. Advisory, like the hook's own: a failure keeps the hook's block. */
function withoutPersona(block: ContextBlock, options: FleetMemoryPortOptions): ContextBlock | undefined {
  if (block.name !== CONTEXT_BLOCKS.brain || options.profileDir === undefined) return block;
  try {
    const excluded = [...options.hook.memory.blocks.map((memoryBlock) => brainSystemFileFor(memoryBlock)), SOLO_PERSONA_FILE];
    const text = renderBrainBlock({ brain: createBrain({ profileDir: options.profileDir }), excludeSystemFiles: excluded });
    return text === "" ? undefined : { ...block, text };
  } catch {
    return block;
  }
}

export function soloMemoryFromFleetHook(options: FleetMemoryPortOptions): SoloMemory {
  const { hook, companyId } = options;
  return async ({ runId, objective }) => {
    hook.runStarted({ runId, companyId, objective });
    try {
      const seat = hook.wrapSeatModel(async () => undefined);
      // `overallObjective` is how the hook tells two runs in flight apart (`runFor`).
      await seat({ companyId, subtask: { id: `${runId}-${SOLO_SEAT}`, seat: SOLO_SEAT, objective, contextBundle: { overallObjective: objective } }, systemPrompt: "", dynamicPrompt: "" });
      const kept = hook.contextFor(runId, SOLO_SEAT)?.kept ?? [];
      return {
        stable: kept.filter((block) => block.tier === "stable").flatMap((block) => withoutPersona(inSoloWords(block, options), options) ?? []), // [CF] inSoloWords
        context: kept.filter((block) => block.tier !== "stable" && block.name !== CONTEXT_BLOCKS.stableVersion),
      };
    } finally {
      hook.runFinished(runId);
    }
  };
}
