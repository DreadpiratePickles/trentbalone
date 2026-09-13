/**
 * Fleet memory for one CLI session: the company memory every seat shares.
 *
 * `wireFleetMemory` builds the `@trent/core/fleet-memory` hook the orchestrator takes as
 * `deps.fleetMemory`: the shared `memory` and `fleet_search` / `fleet_skill_view` adapters, the
 * frozen per-run prelude (MEMORY.md / USER.md, shared skills index, cross-agent recall) and the
 * run boundaries. It is the one place the REPL — or any other CLI run path — decides where the
 * memory files live (`<profile>/memories/`) and which store the recall reads (the company's own
 * SQLite through the app's run snapshots, plus the improve tables when the store carries them).
 *
 * Nothing here logs a prompt body or a memory entry.
 */

import { createAppFleetSource, createFleetMemoryHook, type FleetMemoryHook } from "@trent/core/fleet-memory/index.js";
import type { ImproveStorePort } from "@trent/core/store/index.js";
import type { ReplToolListing } from "./types.js";

export interface FleetMemoryWiringDeps {
  /** The profile directory; the memory files live under `<profileDir>/memories/`. */
  readonly profileDir: string;
  /**
   * The session's store. When it carries the improve tables (`PrismaStore.improve()`) the shared
   * skills index joins the prelude; the ephemeral store does not, and recall then reads runs only.
   */
  readonly store?: unknown;
}

/** `store.improve()` when the store has one; the REPL's store type is structural and may not. */
function improveOf(store: unknown): ImproveStorePort | undefined {
  const candidate = store as { improve?: () => ImproveStorePort } | null | undefined;
  return typeof candidate?.improve === "function" ? candidate.improve() : undefined;
}

export function wireFleetMemory(deps: FleetMemoryWiringDeps): FleetMemoryHook {
  const improve = improveOf(deps.store);
  const source = createAppFleetSource(improve === undefined ? {} : { improve });
  return createFleetMemoryHook({ source, profileDir: deps.profileDir });
}

/** The hook's adapters as `/tools` and `/status` list them, after the toolsets. */
export function fleetMemoryToolListing(hook: FleetMemoryHook): ReplToolListing[] {
  return hook.adapters.map((adapter) => ({ name: adapter.name, scopes: adapter.scopes }));
}
