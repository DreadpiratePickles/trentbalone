/**
 * The headless session runtime: the object graph a Trent session runs on, with no terminal.
 *
 * store -> tools -> fleet memory -> improve loop -> orchestrator -> company. The classic REPL
 * builds its engine on top of this; the gateway handler, the cron runner and the heartbeat need
 * exactly the same graph with nothing on screen. Everything the user types on any of those
 * surfaces goes to `createOrchestrator()`, which streams real events from the real bus over the
 * real model gateway. There is no canned reply path in this file or in any file it imports.
 *
 * Nothing terminal-specific lives here: no theme, no `writeLine`, no exit, no degraded banner.
 */

import process from "node:process";
import type { ConfigManager } from "@trent/core";
import {
  createAppDelegatedChildRunner,
  createOrchestrator as createRealOrchestrator,
  createOrchestratorDelegatePort,
  type OrcEvent,
  type OrchestrationTrigger,
  type Orchestrator,
} from "@trent/core/orchestrator/index.js";
import type { FleetMemoryHook } from "@trent/core/fleet-memory/index.js";
import type { ImproveRunDeps } from "../commands/improve.js";
import { EphemeralStore } from "../repl/ephemeral-store.js";
import { wireFleetMemory } from "../repl/fleet-memory.js";
import { wireImproveLoop } from "../repl/improve-loop.js";
import { wireTools, type ToolWiring, type ToolWiringDeps } from "../repl/tools.js";
import type { ReplConfig, ReplStore } from "../repl/types.js";

/** The company a local session runs against when config names none. Found again by slug on restart. */
export const DEFAULT_COMPANY = { name: "Trent Local", slug: "trent-local" } as const;

/** What `openStore` resolves: the durable SQLite store, or the in-process one and a flag saying so. */
export interface OpenedStore {
  readonly store: ReplStore;
  readonly durable: boolean;
}

/**
 * The collaborators the runtime is built from. Defaults are the real ones; the tests (and the
 * REPL's tests, through `ReplDeps`) inject a recording orchestrator factory, an observed proxy
 * and a Docker probe that needs no daemon.
 */
export interface HeadlessRuntimeDeps {
  readonly configManager: ConfigManager;
  /** Already-loaded config, when the caller has it; otherwise `configManager.loadConfig()`. */
  readonly config?: ReplConfig;
  /** The directory `trent` was launched in. Defaults to `process.cwd()`; never the home directory. */
  readonly workspace?: string;
  readonly createOrchestrator?: typeof createRealOrchestrator;
  readonly buildAdapters?: ToolWiringDeps["buildAdapters"];
  readonly startEgress?: ToolWiringDeps["startEgress"];
  readonly probeDocker?: ToolWiringDeps["probeDocker"];
  /** Opens the durable store for a database URL. Defaults to `openStore` below. */
  readonly openStore?: (databaseUrl: string) => Promise<OpenedStore>;
}

export interface HeadlessRunOptions {
  /** Defaults to `manual`; schedulers pass `scheduled` or `heartbeat`. */
  readonly trigger?: OrchestrationTrigger;
  readonly signal?: AbortSignal;
}

export interface HeadlessRuntime {
  readonly orchestrator: Orchestrator;
  readonly companyId: string;
  readonly store: ReplStore;
  readonly durable: boolean;
  readonly tools: ToolWiring;
  readonly fleetMemory: FleetMemoryHook;
  readonly improve: ImproveRunDeps;
  /** One run against the session's company: the orchestrator's event stream. */
  run(objective: string, options?: HeadlessRunOptions): AsyncIterable<OrcEvent>;
  /** Releases the proxy and the sandboxes. Idempotent, so every exit path may call it. */
  cleanup(): Promise<void>;
}

/** Opens the durable store, or says plainly that this session will not persist. */
export async function openStore(databaseUrl: string): Promise<OpenedStore> {
  try {
    const { createSqliteStore } = await import("@trent/core/store/index.js");
    return { store: (await createSqliteStore({ url: databaseUrl })) as unknown as ReplStore, durable: true };
  } catch {
    // bun:sqlite is unavailable under plain Node. Never silently degrade: the caller
    // prints a warning, and approvals will not survive this process.
    return { store: new EphemeralStore(), durable: false };
  }
}

export async function createHeadlessRuntime(deps: HeadlessRuntimeDeps): Promise<HeadlessRuntime> {
  const config = deps.config ?? (deps.configManager.loadConfig() as unknown as ReplConfig);
  const profileDir = deps.configManager.getProfileDir();

  // `delegate_task` binds to the orchestrator's own delegated child step: the port is built
  // here so the same object is both the tool's port and the orchestrator's hook.
  const delegate = createOrchestratorDelegatePort({ runner: createAppDelegatedChildRunner() });

  // The seats' toolsets and the egress proxy, before the first turn. The workspace is where
  // `trent` was launched, never the home directory. Everything from here on is released by
  // `cleanup()` on every exit path: stdin end, a throw, and Ctrl+C.
  const tools: ToolWiring = await wireTools({
    config: config as unknown as ToolWiringDeps["config"],
    workspace: deps.workspace ?? process.cwd(),
    profileDir,
    configManager: deps.configManager,
    buildAdapters: deps.buildAdapters,
    startEgress: deps.startEgress,
    probeDocker: deps.probeDocker,
    delegate,
  });

  try {
    const databaseUrl = `file:${profileDir}/trent.db`;
    const { store, durable } = await (deps.openStore ?? openStore)(databaseUrl);

    // The company memory every seat shares: MEMORY.md / USER.md under the profile, recall over
    // this company's runs, and the shared skills index when the store carries the improve tables.
    const fleetMemory = wireFleetMemory({ profileDir, store });
    // The self-improvement loop: traces from every run, and promoted skills back into every seat.
    const improve = wireImproveLoop({ store, config });

    // The configured provider/model travel with the orchestrator, which maps them into the env
    // its model resolver reads before the first apps/web import (live proof, F2).
    const createOrchestrator = deps.createOrchestrator ?? createRealOrchestrator;
    const orchestrator = createOrchestrator({
      ...(durable ? { databaseUrl } : {}),
      model: { provider: config.provider, model: config.model },
      tools: tools.adapters,
      fleetMemory,
      delegate,
      ...improve,
    });
    // `launchOrchestration` throws "Company not found" for an id nothing created; an explicit
    // config id is trusted, otherwise the local company is found by slug or created.
    const configuredId = (config as { company?: { id?: string } }).company?.id;
    const companyId = configuredId !== undefined ? String(configuredId) : await orchestrator.ensureCompany(DEFAULT_COMPANY);

    return {
      orchestrator,
      companyId,
      store,
      durable,
      tools,
      fleetMemory,
      improve,
      run: (objective, options = {}) =>
        orchestrator.run({ companyId, objective, trigger: options.trigger ?? "manual", signal: options.signal }),
      cleanup: () => tools.cleanup(),
    };
  } catch (error) {
    // The graph did not come up: the proxy and the sandboxes already running must not outlive it.
    await tools.cleanup();
    throw error;
  }
}
