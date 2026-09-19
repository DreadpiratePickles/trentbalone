/**
 * Fleet memory for one CLI session: the company memory every seat shares.
 *
 * `wireFleetMemory` builds the `@trent/core/fleet-memory` hook the orchestrator takes as
 * `deps.fleetMemory`: the shared `memory` and `fleet_search` / `fleet_skill_view` adapters, the
 * frozen per-run prelude (the named memory blocks, shared skills index, cross-agent recall) and the
 * run boundaries. It is the one place the REPL — or any other CLI run path — decides where the
 * memory files live (`<profile>/memories/`) and which store the recall reads (the company's own
 * SQLite through the app's run snapshots, plus the improve tables when the store carries them).
 *
 * Three seams pass through here and each one was, until now, built and then dropped on the floor:
 *   [C3] the embedder. `embedderForProfile` returns the configured provider's `EmbedFn`, and
 *        nothing passed it, so every production run ranked recall lexically however
 *        `memory.embedder` was set and `trent doctor` reported a ranker no run used.
 *   [C2] `brain.enabled` and `brain.versioning`. The hook defaulted the brain on with `auto`
 *        versioning whatever the profile said, so turning the brain off in config did nothing.
 *   [C1] the app's company memory. Its READ side rides on `createAppFleetSource` and was already
 *        live; the WRITE side needed the `memory` adapter wrapped, which is done here because this
 *        is the only place that has the profile, the run and the seat at once.
 *
 * The config those three come from is read through a `ConfigManager` derived from `profileDir`,
 * the inverse of `ConfigManager.getProfileDir()`. Callers hand this function a directory and not a
 * manager (`apps/cli/src/runtime/headless.ts`), and a wiring that silently ignores config is worse
 * than one extra file read per session.
 *
 * Nothing here logs a prompt body or a memory entry.
 */

import path from "node:path";
import { ConfigManager } from "@trent/core/config/index.js";
import {
  createAppFleetSource,
  createBrain,
  createFleetMemoryHook,
  embedderForProfile,
  loadAppWriteModules,
  withAppEpisodicMirror,
  type AppMemoryWriteModules,
  type ContextNotice,
  type FleetMemoryHook,
  type FleetMemoryHookOptions,
  type MemoryBlock,
} from "@trent/core/fleet-memory/index.js";
import { createMemoryAdapter } from "@trent/core/tools/memory/index.js";
import type { ImproveStorePort } from "@trent/core/store/index.js";
import type { ReplToolListing } from "./types.js";

/** The three methods `embedderForProfile` and the brain keys read. `ConfigManager` satisfies it. */
export interface FleetMemoryConfigSource {
  loadConfig(): unknown;
  loadSecrets(): unknown;
  getProfileDir(): string;
}

export interface FleetMemoryWiringDeps {
  /** The profile directory; the memory files live under `<profileDir>/memories/`. */
  readonly profileDir: string;
  /**
   * The session's store. When it carries the improve tables (`PrismaStore.improve()`) the shared
   * skills index joins the prelude; the ephemeral store does not, and recall then reads runs only.
   */
  readonly store?: unknown;
  /** Config `memory.blocks`; the three shipped blocks (memory, user, company) when omitted. */
  readonly blocks?: readonly MemoryBlock[];
  /**
   * `context.ceiling_chars`: the ceiling on the whole assembled injection. Over it the context and
   * volatile tiers are trimmed oldest-first and the stable tier never is.
   */
  readonly ceilingChars?: number;
  /**
   * The active personality's `systemPromptSuffix` (`compact.ts` `personalitySuffix`). It lands in
   * the VOLATILE tier and nowhere else: never the system prompt, never the protected seat prompt.
   */
  readonly personalitySuffix?: string;
  /**
   * A2.1's rendered workspace context (`AGENTS.md`, `CLAUDE.md`, `.trent/*.md`), already scanned
   * and trusted by its own module. This wiring opens no file.
   */
  readonly workspaceContext?: string;
  /** Receives `context_pressure` once per run; the orchestrator also bridges it onto the run bus. */
  readonly onNotice?: (notice: ContextNotice) => void;
  /** The surface's own manager, when it has one; derived from `profileDir` otherwise. */
  readonly configManager?: FleetMemoryConfigSource;
  /** [C1] The app's writers; the real ones, loaded lazily on the first mirrored append, by default. */
  readonly appMemoryWrites?: AppMemoryWriteModules;
  /**
   * [C1] One line when a seat's append could not be mirrored into the app's company memory. The
   * SEAT is never told: its write reached the blocks, which is the write it made, and a profile
   * whose app store cannot answer is a fact about the profile, not about the fact it recorded.
   * `trent doctor` reports the same condition standing still.
   */
  readonly onAppMemoryFailure?: (message: string) => void;
}

/** `store.improve()` when the store has one; the REPL's store type is structural and may not. */
function improveOf(store: unknown): ImproveStorePort | undefined {
  const candidate = store as { improve?: () => ImproveStorePort } | null | undefined;
  return typeof candidate?.improve === "function" ? candidate.improve() : undefined;
}

/**
 * The inverse of `ConfigManager.getProfileDir()`: `<base>` is the default profile and
 * `<base>/profiles/<name>` is a named one. An explicit profile beats `TRENT_PROFILE`, so a session
 * launched into one profile never reads another profile's config.
 */
export function configSourceFor(profileDir: string): FleetMemoryConfigSource {
  const parent = path.dirname(profileDir);
  if (path.basename(parent) === "profiles") {
    return new ConfigManager({ baseDir: path.dirname(parent), profile: path.basename(profileDir) });
  }
  return new ConfigManager({ baseDir: profileDir, profile: "default" });
}

/** `brain.enabled` / `brain.versioning` as the config carries them; absent means the shipped default. */
interface BrainSlice {
  brain?: { enabled?: boolean; versioning?: "auto" | "off" };
}

/**
 * The options the hook is built from, exported so the wiring itself is assertable: a hook does not
 * say which ranker or which brain it was handed, and that is exactly how three seams came to be
 * built and never connected.
 */
export function fleetMemoryHookOptions(deps: FleetMemoryWiringDeps): FleetMemoryHookOptions {
  const improve = improveOf(deps.store);
  const config = deps.configManager ?? configSourceFor(deps.profileDir);
  // [C3] The configured embedder, or `undefined` when nothing is configured — passing the lexical
  // one through the seam would blend lexical vectors with themselves.
  const embed = embedderForProfile(config as Parameters<typeof embedderForProfile>[0]);
  // [C2] The brain the profile asked for. `false` creates no `brain/` directory at all.
  const brain = (config.loadConfig() as BrainSlice).brain;
  const brainOption =
    brain?.enabled === false
      ? (false as const)
      : brain?.versioning === undefined
        ? undefined
        : createBrain({ profileDir: deps.profileDir, versioning: brain.versioning });

  return {
    source: createAppFleetSource(improve === undefined ? {} : { improve }),
    profileDir: deps.profileDir,
    ...(deps.blocks === undefined ? {} : { blocks: deps.blocks }),
    ...(deps.ceilingChars === undefined ? {} : { ceilingChars: deps.ceilingChars }),
    ...(deps.personalitySuffix === undefined ? {} : { personalitySuffix: deps.personalitySuffix }),
    ...(deps.workspaceContext === undefined ? {} : { workspaceContext: deps.workspaceContext }),
    ...(deps.onNotice === undefined ? {} : { onNotice: deps.onNotice }),
    ...(embed === undefined ? {} : { embed }),
    ...(brainOption === undefined ? {} : { brain: brainOption }),
  };
}

/** The run, seat and step a `memory` call belongs to, as this wiring tracks it for the mirror. */
interface MirrorCaller {
  companyId: string;
  runId: string;
  seat: string;
  /** [G2] The step in flight; the mirror holds its episodes until the step finishes. */
  stepId?: string;
}

export function wireFleetMemory(deps: FleetMemoryWiringDeps): FleetMemoryHook {
  const options = fleetMemoryHookOptions(deps);

  // [C1] The write side. The adapter is built here so it can be wrapped before the hook takes it:
  // the mirror is a decorator, so `tools/memory` keeps owning the blocks, the gate and the lock and
  // never learns about a store. Only a write the adapter COMPLETED is mirrored, so a refusal, a
  // read-only block and a delegated child's blocked write all mirror nothing.
  let caller: MirrorCaller | undefined;
  let modules: Promise<AppMemoryWriteModules> | undefined;
  const memory = withAppEpisodicMirror(
    createMemoryAdapter({ profileDir: deps.profileDir, ...(deps.blocks === undefined ? {} : { blocks: deps.blocks }) }),
    {
      modules:
        deps.appMemoryWrites ??
        // Lazily: nothing in `apps/web` is imported until a seat actually appends.
        ({
          async writeEpisodicMemory(input) {
            modules ??= loadAppWriteModules();
            await (await modules).writeEpisodicMemory(input);
          },
          createSemanticMemory() {
            throw new Error("a seat never writes a semantic fact; consolidation does");
          },
          async listDocuments() {
            return [];
          },
          async expireDocument() {},
        } satisfies AppMemoryWriteModules),
      caller: () => caller,
      ...(deps.onAppMemoryFailure === undefined
        ? {}
        : {
            onFailure: (reason) =>
              deps.onAppMemoryFailure?.(
                `A seat's memory append did not reach the company's app memory, so only this profile's blocks carry it: ${reason}`,
              ),
          }),
    },
  );

  // [G2] The mirror's step boundaries come from the hook, which is the one place that watches a
  // seat call begin and end. An episode held for a step that never finished is dropped rather than
  // written: an append made inside a turn the user stopped is the seat's own record, not something
  // the company learned.
  const hook = createFleetMemoryHook({
    ...options,
    memory: memory.adapter,
    onStepSettled: (settled) =>
      void memory.stepSettled(settled).catch((error: unknown) => deps.onAppMemoryFailure?.(String(error))),
  });

  // The run and the seat are tracked the same way the hook tracks its own caller context: set on
  // the way in, one seat call at a time. A `memory` call happens inside `fn(input)`, so the seat
  // that made it is the seat this saw last.
  return {
    ...hook,
    runStarted(input) {
      caller = { companyId: input.companyId, runId: input.runId, seat: "" };
      hook.runStarted(input);
    },
    runFinished(runId) {
      if (caller?.runId === runId) caller = undefined;
      // The hook settles the steps still in flight first, so the mirror hears about each one; what
      // reaches `runEnded` is whatever no seat call ever claimed.
      hook.runFinished(runId);
      memory.runEnded(runId);
    },
    wrapSeatModel(fn) {
      const wrapped = hook.wrapSeatModel(fn);
      return async (input) => {
        if (caller !== undefined) {
          caller.seat = input.subtask.seat;
          caller.stepId = input.subtask.id;
        }
        try {
          return await wrapped(input);
        } finally {
          // [G2] Outside the seat call there is no step to hold a write for: a `memory` append made
          // between steps is written at once rather than waiting on a step that has already ended.
          if (caller !== undefined) caller.stepId = undefined;
        }
      };
    },
  };
}

/** The hook's adapters as `/tools` and `/status` list them, after the toolsets. */
export function fleetMemoryToolListing(hook: FleetMemoryHook): ReplToolListing[] {
  return hook.adapters.map((adapter) => ({ name: adapter.name, scopes: adapter.scopes }));
}
