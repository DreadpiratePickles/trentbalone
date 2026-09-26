/**
 * [S3] The provenance gate on the fleet-memory adapters in solo (item 2; council B5, B3).
 *
 * [C2] The wrapper moved to `tools/memory/gate.ts`, so ONE gate serves both modes: the fleet
 * (`orchestrator/index.ts`) wraps the hook's adapters with it too, with the tool chain's own ledger.
 * What stays here is solo's binding of it: a held row names the solo seat (`trent`) unless the caller
 * names another. A solo run is bound to its conversation's taint, which every ledger instance reads
 * first (`governance/provenance.ts`), so solo needs no particular ledger.
 */
import { gatedMemoryAdapters as gateMemoryAdapters, type MemoryGateOptions } from "../tools/memory/gate.js"; // [C2]
import type { TrentToolAdapter } from "../tools/types.js";
import { SOLO_SEAT } from "./types.js";

export type { MemoryGateOptions } from "../tools/memory/gate.js"; // [C2]

export function gatedMemoryAdapters(adapters: readonly TrentToolAdapter[], options: MemoryGateOptions = {}): TrentToolAdapter[] {
  return gateMemoryAdapters(adapters, { ...options, seat: options.seat ?? SOLO_SEAT }); // [C2]
}
