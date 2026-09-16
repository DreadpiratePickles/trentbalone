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
import type { FleetMemoryHook, MemoryBlock } from "@trent/core/fleet-memory/index.js";
import { createAlertHook, type AlertBudgetPort, type AlertHook, type AlertHookDeps } from "@trent/core/gateway/index.js";
import type { BusHook } from "@trent/core/improve/index.js";
import { applyPrivacyEnv, createPromptRedactor, type PromptPrivacyConfig } from "@trent/core/model-gateway/index.js";
import { OTelExporter, composeBusHooks, createOTelBusHook, type OTelBusHook } from "@trent/core/traces/index.js";
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
  /**
   * Extra hooks on the run bus, composed with the improve loop and telemetry: each sees every
   * event of every run this runtime executes (REPL, gateway, cron, heartbeat) and is flushed
   * before a run settles. The gateway's approval link rides here.
   */
  readonly busHooks?: readonly BusHook[];
  /**
   * Where push alerts go: the gateway manager (or anything with its `send`) and, optionally,
   * the budget to watch. The owner and the approval wait come from `config.gateway`; with no
   * owner the hook is inert and says so once. Absent, no alert hook is built at all.
   */
  readonly alerts?: HeadlessAlertDeps;
}

export interface HeadlessAlertDeps {
  readonly manager: AlertHookDeps["manager"];
  readonly budget?: AlertBudgetPort;
  readonly log?: (line: string) => void;
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
  /** The OTel export hook, present only when `telemetry.otlp_endpoint` is configured. */
  readonly telemetry: OTelBusHook | undefined;
  /** The push-alert hook, present only when `alerts` was injected; `active` says whether an owner is set. */
  readonly alerts: AlertHook | undefined;
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

/** The `telemetry` config block as the runtime reads it; `TrentConfig` satisfies it structurally. */
interface TelemetrySlice {
  telemetry?: { otlp_endpoint?: string; service_name?: string };
}

/** The `gateway` config block as the alert hook reads it; `TrentConfig` satisfies it structurally. */
interface GatewaySlice {
  gateway?: { owner?: { platform: string; channelId: string }; alerts?: { approval_wait_minutes?: number } };
}

/** The `privacy` config block as the model gateway reads it; `TrentConfig` satisfies it structurally. */
interface PrivacySlice {
  privacy?: PromptPrivacyConfig;
}

/** The `memory` config block the fleet memory wiring reads; `TrentConfig` satisfies it structurally. */
interface MemorySlice {
  memory?: { blocks?: MemoryBlock[] };
}

const DEFAULT_APPROVAL_WAIT_MINUTES = 30;

/**
 * Prompt redaction (T3.2) for this config. The orchestrator builds the model gateway with no
 * arguments, so the block travels through the env the gateway reads, the way the model block does.
 * The redactor is compiled here first so a bad `privacy.patterns[]` entry fails at startup with
 * its index (exit code 3) rather than on the first prompt. Returns the env names written.
 */
export function wirePromptRedaction(config: PrivacySlice): string[] {
  if (config.privacy === undefined) return [];
  createPromptRedactor({ enabled: config.privacy.redact_prompts, patterns: config.privacy.patterns });
  return applyPrivacyEnv(config.privacy);
}

/**
 * The push-alert hook for this config and sender, or nothing when no sender was injected. The
 * owner and the wait are config; a missing owner leaves the hook inert, and it says so once.
 */
export function wireAlerts(config: GatewaySlice, deps: HeadlessAlertDeps | undefined): AlertHook | undefined {
  if (deps === undefined) return undefined;
  const minutes = config.gateway?.alerts?.approval_wait_minutes ?? DEFAULT_APPROVAL_WAIT_MINUTES;
  return createAlertHook({
    manager: deps.manager,
    owner: config.gateway?.owner,
    budget: deps.budget,
    approvalWaitMs: minutes * 60_000,
    log: deps.log,
  });
}

/**
 * The OTel bus hook for this config, or nothing when no endpoint is set. Tracing off means no
 * exporter is built at all, so an unconfigured session never buffers spans it cannot ship.
 */
export function wireTelemetry(config: TelemetrySlice, onError?: (message: string) => void): OTelBusHook | undefined {
  const endpoint = config.telemetry?.otlp_endpoint;
  if (!endpoint) return undefined;
  const exporter = new OTelExporter({ endpoint, serviceName: config.telemetry?.service_name ?? "trent" });
  return createOTelBusHook(exporter, onError === undefined ? {} : { onError });
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
    const fleetMemory = wireFleetMemory({ profileDir, store, blocks: (config as MemorySlice).memory?.blocks });
    // The self-improvement loop: traces from every run, and promoted skills back into every seat.
    const improve = wireImproveLoop({ store, config });
    // OTel export, when config names a collector: composed onto the same bus hook the improve
    // loop uses, so the orchestrator sees one sink and one flush.
    const telemetry = wireTelemetry(config as TelemetrySlice);
    // Push alerts to `gateway.owner`: failures, unanswered gates and budget thresholds ride the
    // same hook, so they see every run this runtime executes.
    const alerts = wireAlerts(config as GatewaySlice, deps.alerts);
    const busHook = composeBusHooks(
      improve.improve,
      ...(telemetry === undefined ? [] : [telemetry]),
      ...(alerts === undefined ? [] : [alerts]),
      ...(deps.busHooks ?? []),
    );

    // The configured provider/model travel with the orchestrator, which maps them into the env
    // its model resolver reads before the first apps/web import (live proof, F2). The privacy
    // block takes the same road, before the gateway is built.
    wirePromptRedaction(config as PrivacySlice);
    const createOrchestrator = deps.createOrchestrator ?? createRealOrchestrator;
    // `runtime.max_concurrent_runs` (T3.5): runs past the cap wait FIFO for a slot; absent, the
    // orchestrator's own default applies.
    const orchestrator = createOrchestrator({
      ...(durable ? { databaseUrl } : {}),
      model: { provider: config.provider, model: config.model },
      tools: tools.adapters,
      fleetMemory,
      delegate,
      ...improve,
      improve: busHook,
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
      telemetry,
      alerts,
      run: (objective, options = {}) =>
        orchestrator.run({ companyId, objective, trigger: options.trigger ?? "manual", signal: options.signal }),
      cleanup: async () => {
        alerts?.close();
        await tools.cleanup();
      },
    };
  } catch (error) {
    // The graph did not come up: the proxy and the sandboxes already running must not outlive it.
    await tools.cleanup();
    throw error;
  }
}
