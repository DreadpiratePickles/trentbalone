/**
 * [S2] Which gate frames open an approval card (council A3).
 *
 * The bus reports one gate as two frames, `step_awaiting_approval` then `run_awaiting_approval`, so
 * the engine keys a gate by (run, step) and opens ONE card for the pair. A seat rarely gates twice in
 * one step; a solo run has one step for all its calls and gates every held one, so a key that lived
 * for the whole turn skipped the second held call: no card, `y`/`n` doing nothing, the run parked.
 * The key is now released as soon as the step moves on (its approval, its next output, its end), so
 * each held call gets its own card and the sibling frame of the same gate still does not.
 */
import type { OrcEvent } from "@trent/core/orchestrator/index.js";

const GATE_KINDS: ReadonlySet<OrcEvent["kind"]> = new Set(["step_awaiting_approval", "run_awaiting_approval"]);
const MOVES_ON: ReadonlySet<OrcEvent["kind"]> = new Set(["step_approved", "step_output", "step_end"]);

export class GateKeys {
  readonly #open = new Set<string>();

  /** True when this frame should open a card: a gate frame whose gate has no card yet. */
  admit(event: OrcEvent): boolean {
    if (MOVES_ON.has(event.kind) && event.step?.id !== undefined) this.#open.delete(`${event.runId}/${event.step.id}`);
    if (!GATE_KINDS.has(event.kind)) return false;
    const key = `${event.runId}/${event.step?.id ?? event.at}`;
    if (this.#open.has(key)) return false;
    this.#open.add(key);
    return true;
  }

  clear(): void {
    this.#open.clear();
  }
}
