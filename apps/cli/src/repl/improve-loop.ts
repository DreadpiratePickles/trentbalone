/**
 * The self-improvement loop in the REPL run path: `createImproveRunDeps` (commands/improve.ts)
 * spread into `createOrchestrator`, so every run writes traces and every seat call sees the
 * skills a human promoted with `trent improve promote`. When the session's store has no improve
 * tables (plain Node, no bun:sqlite) the loop runs against the process-local store the
 * `improve` command also falls back to, so a promotion made in this process still reaches a seat.
 *
 * It also decides where failure goldens go. `improve/hook.ts` builds the capture only when it is
 * handed a directory, and this wiring handed it none, so no production run ever captured a
 * fixture. The directory is derived here rather than at the call sites: every surface that wires
 * the loop passes the profile it already has (or nothing, and the profile is resolved the way
 * `ConfigManager` resolves it everywhere else), so a new surface cannot forget to turn capture on.
 */

import { chmodSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { ConfigManager } from "@trent/core/config/index.js";
import type { ImproveStorePort } from "@trent/core/store/index.js";
import { createImproveRunDeps, fallbackImproveStore, type ImproveRunDeps } from "../commands/improve.js";

/**
 * A golden carries the objective of a failed run — sanitised, but still the founder's own words.
 * The directory is therefore owner-only, like `sessions/` and `.env` beside it.
 */
const GOLDEN_DIR_MODE = 0o700;

export interface ImproveLoopWiring {
  readonly store: unknown;
  readonly config: { profile?: string; fleet?: { installed_agents?: string[]; active_agents?: string[] } };
  /** The profile directory whose `goldens/` receives failure fixtures. Omit and it is resolved. */
  readonly profileDir?: string;
  /** The surface's own manager, when it has one; used only for its profile directory. */
  readonly configManager?: { getProfileDir(): string };
  /** Diagnostic channel for a capture that could not be armed or a trace that failed to write. */
  readonly onError?: (message: string) => void;
}

/** `store.improve()` when the store has one; the REPL's store type is structural and may not. */
function improveOf(store: unknown): ImproveStorePort | undefined {
  const candidate = store as { improve?: () => ImproveStorePort } | null | undefined;
  return typeof candidate?.improve === "function" ? candidate.improve() : undefined;
}

/**
 * Explicit directory, then the caller's manager, then the same resolution every other profile
 * path uses: `$TRENT_PROFILE`, else the profile named in the loaded config, else `default`.
 */
function profileDirOf(input: ImproveLoopWiring): string {
  if (input.profileDir !== undefined) return input.profileDir;
  if (input.configManager !== undefined) return input.configManager.getProfileDir();
  const profile = process.env.TRENT_PROFILE ?? input.config.profile;
  return new ConfigManager(profile === undefined ? {} : { profile }).getProfileDir();
}

/**
 * `<profileDir>/goldens`, created on demand. The mode is applied by an explicit `chmod` on the
 * directory we created, because `mkdir`'s mode is masked by the process umask. A profile on a
 * read-only or unwritable home leaves capture off rather than failing the run that wired it.
 */
function goldenDirOf(input: ImproveLoopWiring): string | undefined {
  const dir = path.join(profileDirOf(input), "goldens");
  try {
    const existed = existsSync(dir);
    mkdirSync(dir, { recursive: true, mode: GOLDEN_DIR_MODE });
    if (!existed) chmodSync(dir, GOLDEN_DIR_MODE);
    return dir;
  } catch (error) {
    input.onError?.(`golden capture is off: ${dir} could not be created: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

export function wireImproveLoop(input: ImproveLoopWiring): ImproveRunDeps {
  const goldenDir = goldenDirOf(input);
  return createImproveRunDeps({
    store: improveOf(input.store) ?? fallbackImproveStore(),
    installedAgents: [...(input.config.fleet?.installed_agents ?? input.config.fleet?.active_agents ?? [])],
    ...(goldenDir === undefined ? {} : { goldenDir }),
    ...(input.onError === undefined ? {} : { onError: input.onError }),
  });
}
