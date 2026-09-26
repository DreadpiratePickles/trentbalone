/**
 * [C2] The provenance gate on the fleet-memory hook's adapters, for BOTH modes (council C2; S3 item 2).
 *
 * `buildTrentTools` wraps every adapter it builds in the gate chain, and the fleet-memory hook's
 * `memory` / `fleet_search` / `brain_read` are not among them: the hook registers them itself, and
 * both runners add them after the chain (the fleet in `orchestrator/index.ts`, solo in the runtime's
 * `runner-for-mode.ts`). Unwrapped, a step that read a web page could write what the page said into
 * the MEMORY.md every seat loads as trusted next run. Both modes wrap those adapters here, with the
 * SAME provenance wrapper and the SAME durable hold the chain gives its own adapters: a write from
 * untrusted context is parked as a row `trent approvals` decides, and approving it replays the write
 * through the unwrapped adapter with the provenance marker on the entry (`holds.ts`). Reads pass
 * through, tagged.
 *
 * The ledger is the one thing the two modes differ on. Taint is recorded per ledger INSTANCE, keyed
 * by (run, step) (`governance/provenance.ts`), so a fleet run's gate MUST be handed the ledger
 * `buildTrentTools` wrapped the toolsets with: a ledger of its own never sees the `web_extract` the
 * chain recorded. A solo run is bound to its conversation's taint, which every ledger reads first, so
 * any instance serves there.
 */
import { createProvenanceLedger, provenanceAdapters, type HeldWriteInput, type ProvenanceLedger, type ProvenancePolicy } from "../../governance/provenance.js";
import type { TrentToolAdapter } from "../types.js";
import { holdMemoryWrite } from "./holds.js";

export interface MemoryGateOptions {
  /** Where a held write's row is filed (`<profile>/gateway.json`). Absent with no `hold`: a held write is refused. */
  readonly profileDir?: string;
  /** Config `provenance` (`untrusted_writes`, `untrusted_skills`); absent, the shipped default holds. */
  readonly policy?: ProvenancePolicy;
  /** The ledger the tool chain writes to (`TrentToolBuild.provenance`). Absent: a new one, which sees only these adapters' calls. */
  readonly ledger?: ProvenanceLedger;
  /** Replaces the durable hold (tests). Returns the line the model reads, naming the row. */
  readonly hold?: (input: HeldWriteInput) => string;
  /** The row's agent id; absent, `holdMemoryWrite`'s default (`orchestrator`, as the chain's own holds). */
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
            ...(options.seat === undefined ? {} : { seat: options.seat }),
            ...(input.runId === undefined ? {} : { runId: input.runId }),
            ...(input.stepId === undefined ? {} : { stepId: input.stepId }),
          }).line);
  return provenanceAdapters(adapters, {
    ledger: options.ledger ?? createProvenanceLedger(),
    ...(options.policy === undefined ? {} : { policy: options.policy }),
    ...(hold === undefined ? {} : { hold }),
  });
}
