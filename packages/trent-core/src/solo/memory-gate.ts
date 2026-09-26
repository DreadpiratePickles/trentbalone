/**
 * [S3] The provenance gate on the fleet-memory adapters in solo (item 2; council B5, B3).
 *
 * `buildTrentTools` wraps every adapter it builds in the gate chain, and the fleet-memory hook's
 * `memory` / `fleet_search` / `brain_read` are not among them: the hook registers them itself and the
 * orchestrator appends them after the chain (`orchestrator/index.ts`). A solo run that read a web
 * page in one turn could therefore write what the page said into shared memory in the next, with
 * nothing in the way. Solo wraps those adapters with the SAME provenance wrapper and the SAME durable
 * hold the chain gives its own (`tools/index.ts`): a write from untrusted context is parked as a row
 * `trent approvals` decides, and approving it replays the write through the unwrapped adapter with
 * the provenance marker on the entry (`tools/memory/holds.ts`). Reads pass through, tagged.
 *
 * The wrapper keeps no state of its own that matters in solo: a run bound to its conversation's taint
 * reads and writes that taint, whichever ledger instance wraps the call (`governance/provenance.ts`).
 */
import { createProvenanceLedger, provenanceAdapters, type HeldWriteInput, type ProvenanceLedger, type ProvenancePolicy } from "../governance/provenance.js";
import { holdMemoryWrite } from "../tools/memory/holds.js";
import type { TrentToolAdapter } from "../tools/types.js";
import { SOLO_SEAT } from "./types.js";

export interface MemoryGateOptions {
  /** Where a held write's row is filed (`<profile>/gateway.json`). Absent with no `hold`: a held write is refused. */
  readonly profileDir?: string;
  /** Config `provenance` (`untrusted_writes`, `untrusted_skills`); absent, the shipped default holds. */
  readonly policy?: ProvenancePolicy;
  readonly ledger?: ProvenanceLedger;
  /** Replaces the durable hold (tests). Returns the line the model reads, naming the row. */
  readonly hold?: (input: HeldWriteInput) => string;
  /** The row's agent id; default `trent`. */
  readonly seat?: string;
}

export function gatedMemoryAdapters(adapters: readonly TrentToolAdapter[], options: MemoryGateOptions = {}): TrentToolAdapter[] {
  const profileDir = options.profileDir;
  const hold =
    options.hold ??
    (profileDir === undefined
      ? undefined
      : (input: HeldWriteInput): string =>
          holdMemoryWrite({
            profileDir,
            adapter: input.adapter,
            action: input.action,
            sources: input.sources,
            seat: options.seat ?? SOLO_SEAT,
            ...(input.runId === undefined ? {} : { runId: input.runId }),
            ...(input.stepId === undefined ? {} : { stepId: input.stepId }),
          }).line);
  return provenanceAdapters(adapters, {
    ledger: options.ledger ?? createProvenanceLedger(),
    ...(options.policy === undefined ? {} : { policy: options.policy }),
    ...(hold === undefined ? {} : { hold }),
  });
}
