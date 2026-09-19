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
import { closeCheckpointSession, type CheckpointSession } from "@trent/core/checkpoints/index.js";
import { closeGoalSession, watchVerification, type GoalSession } from "@trent/core/goals/index.js";
import {
  createAppDelegatedChildRunner,
  createGoalVerificationPort,
  createOrchestrator as createRealOrchestrator,
  createOrchestratorDelegatePort,
  type ConversationMessage,
  type OrcEvent,
  type OrchestrationTrigger,
  type Orchestrator,
} from "@trent/core/orchestrator/index.js";
import type { FleetMemoryHook } from "@trent/core/fleet-memory/index.js";
import { runSessionHooks } from "@trent/core/hooks/index.js";
import { loadWorkspaceContext, type WorkspaceContext } from "@trent/core/workspace-context/index.js";
import { createVersionPinHook, type VersionPinHook } from "@trent/core/fleet/index.js";
import type { AlertHook } from "@trent/core/gateway/index.js";
import type { BusHook } from "@trent/core/improve/index.js";
import { closeHeldWriteSession, openHeldWriteSession } from "@trent/core/tools/index.js";
import type { ImproveStorePort } from "@trent/core/store/index.js";
import { composeBusHooks, type OTelBusHook } from "@trent/core/traces/index.js";
import {
  sessionHookNotices,
  wireAlerts,
  wireCheckpoints,
  wirePromptRedaction,
  wireRunSpend,
  wireSpendLedger,
  wireTelemetry,
  type CheckpointsSlice,
  type GatewaySlice,
  type HeadlessAlertDeps,
  type HooksSlice,
  type MemorySlice,
  type ModelOverridesSlice,
  type ModelTiersSlice,
  type PrivacySlice,
  type RuntimeSlice,
  type SpendSlice,
  type TelemetrySlice,
  type WorkspaceSlice,
} from "./headless-wiring.js";
import type { ImproveRunDeps } from "../commands/improve.js";
import { EphemeralStore } from "../repl/ephemeral-store.js";
import { wireFleetMemory } from "../repl/fleet-memory.js";
import { contextLimits, personalitySuffix } from "../repl/compact.js";
import { renderWorkspaceContext } from "../repl/workspace.js";
import { wireImproveLoop } from "../repl/improve-loop.js";
import { wireTools, type ToolWiring, type ToolWiringDeps } from "../repl/tools.js";
import type { ReplConfig, ReplStore } from "../repl/types.js";
import { wireGoals, type GoalsSlice } from "./goals.js";

export {
  sessionHookNotices,
  wireAlerts,
  wireCheckpoints,
  wirePromptRedaction,
  wireRunSpend,
  wireSpendLedger,
  wireTelemetry,
} from "./headless-wiring.js";
export type { HeadlessAlertDeps, SpendLedgerSession } from "./headless-wiring.js";

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
  /**
   * An extra observer of every event of every run, composed AFTER the fleet-memory hook's own
   * sink. The hook's sink is not optional and is not replaceable: it is the failure channel.
   */
  readonly traceSink?: (event: OrcEvent) => void;
  // [G3.1] the one daily spend ledger
  /**
   * Which surface built this graph — `repl`, `run`, `gateway`, `cron`, `heartbeat`, `a2a`, `acp`.
   * It tags every run this runtime executes, and so every row the run writes to the profile's
   * `spend.ndjson`, which is what makes `budget.daily_cap` one cap rather than one per surface.
   * A runtime that names none tags its runs `unknown` — recorded, so the gap is visible.
   */
  readonly surface?: string;
}

export interface HeadlessRunOptions {
  /** Defaults to `manual`; schedulers pass `scheduled` or `heartbeat`. */
  readonly trigger?: OrchestrationTrigger;
  readonly signal?: AbortSignal;
  /**
   * The surface's earlier turns, oldest first. The objective stays the raw new line; the
   * transcript is rendered after the fleet-memory prelude, never before it.
   */
  readonly history?: readonly ConversationMessage[];
  // [G3.1] the one daily spend ledger
  /**
   * The surface this ONE run is charged to, when it is not the runtime's own: cron and the
   * heartbeat are handed the gateway's already-built runtime (`servers.ts`), so without this their
   * spend would read as the gateway's. Defaults to the runtime's surface.
   */
  readonly surface?: string;
}

export interface HeadlessRuntime {
  readonly orchestrator: Orchestrator;
  readonly companyId: string;
  /**
   * A2.1: the workspace this session was launched in, as the trust record and the scanner left it.
   * Its blocks are already in the stable tier; a surface reads this to say what was NOT loaded.
   */
  readonly workspace: WorkspaceContext;
  readonly store: ReplStore;
  readonly durable: boolean;
  readonly tools: ToolWiring;
  readonly fleetMemory: FleetMemoryHook;
  readonly improve: ImproveRunDeps;
  /** The OTel export hook, present only when `telemetry.otlp_endpoint` is configured. */
  readonly telemetry: OTelBusHook | undefined;
  /** The push-alert hook, present only when `alerts` was injected; `active` says whether an owner is set. */
  readonly alerts: AlertHook | undefined;
  /** T4.1: the live agent version ids each run was pinned to at its `run_start`; absent without a durable store. */
  readonly versionPins: VersionPinHook | undefined;
  // [E1] checkpoints
  /**
   * The agent-write ledger this session records into, absent when `checkpoints.enabled` is false.
   * `file_ops` finds it through the process rather than through this handle; a surface reads it
   * for `/checkpoints` and `/rollback`.
   */
  readonly checkpoints: CheckpointSession | undefined;
  // [D4] goals
  /**
   * The goal store, the turn's verification evidence and the sandbox a quality gate runs in.
   * `/goal` and `trent goal` find the same object on the process (`activeGoalSession()`).
   */
  readonly goals: GoalSession;
  /** One run against the session's company: the orchestrator's event stream. */
  run(objective: string, options?: HeadlessRunOptions): AsyncIterable<OrcEvent>;
  /**
   * Lines the surface must show once: a configured hook that did not run (unconsented, or its spec
   * changed since consent) and a session hook that ran and failed. Read after a turn as well as at
   * start-up, because a tool hook is skipped when a CALL is made, not when the graph is built.
   */
  notices(): readonly string[];
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
  const workspace = deps.workspace ?? process.cwd();
  // A2.1. Trust is checked, the files are scanned and the caps are applied inside this call; an
  // untrusted workspace yields no blocks and one instruction line. Nothing here opens a file.
  const workspaceContext = loadWorkspaceContext({ cwd: workspace, profileDir, config: config as WorkspaceSlice });
  const workspaceBlock = renderWorkspaceContext(workspaceContext);
  // A2.2. One line per hook the session could not run; the tool hooks add theirs as calls are made.
  const notices: string[] = [];
  // [E1] Before the toolsets: `file_ops` ledgers a write only while a session is open.
  const checkpoints = wireCheckpoints(config as CheckpointsSlice, { workspace, profileDir });
  // [G3.1] Before anything can spend: the profile's daily ledger, installed explicitly by this
  // surface and given back by `cleanup()`. Every surface is on it by being built here at all.
  const spend = wireSpendLedger(config as SpendSlice, { profileDir });
  const chargeSpend = wireRunSpend(config.provider);
  // [D4] The goal store, the turn's verification evidence and the sandbox a quality gate runs in.
  const goals = wireGoals(config as GoalsSlice, { workspace, profileDir, backend: config.terminal.backend === "docker" ? "docker" : "local" });

  // `delegate_task` binds to the orchestrator's own delegated child step: the port is built
  // here so the same object is both the tool's port and the orchestrator's hook.
  const delegate = createOrchestratorDelegatePort({ runner: createAppDelegatedChildRunner() });

  // The seats' toolsets and the egress proxy, before the first turn. The workspace is where
  // `trent` was launched, never the home directory. Everything from here on is released by
  // `cleanup()` on every exit path: stdin end, a throw, and Ctrl+C.
  const tools: ToolWiring = await wireTools({
    config: config as unknown as ToolWiringDeps["config"],
    workspace,
    profileDir,
    configManager: deps.configManager,
    buildAdapters: deps.buildAdapters,
    startEgress: deps.startEgress,
    probeDocker: deps.probeDocker,
    delegate,
  });
  // [D4] The seats' shell and code calls are offered to the turn's evidence ledger on the way
  // through, which is the only way `verify_on_stop` can know a test ran: a `ToolCallRecord` carries
  // a status and a summary, and the orchestrator never sees the command at all. The watched
  // adapters replace the originals IN PLACE, so the session, the orchestrator and `/tools` are all
  // still looking at one set of adapters rather than two that can drift.
  tools.adapters.splice(0, tools.adapters.length, ...watchVerification(tools.adapters, goals.evidence));

  try {
    const databaseUrl = `file:${profileDir}/trent.db`;
    const { store, durable } = await (deps.openStore ?? openStore)(databaseUrl);

    // The company memory every seat shares: MEMORY.md / USER.md under the profile, recall over
    // this company's runs, and the shared skills index when the store carries the improve tables.
    // `context.ceiling_chars` bounds the whole injection; the active personality's suffix rides
    // the volatile tier of it and reaches a model nowhere else (`improve/protected-prompt.ts`).
    const limits = contextLimits(config as unknown as Parameters<typeof contextLimits>[0]);
    const suffix = personalitySuffix(deps.configManager);
    const fleetMemory = wireFleetMemory({
      profileDir,
      store,
      blocks: (config as MemorySlice).memory?.blocks,
      ceilingChars: limits.ceilingChars,
      ...(suffix === undefined ? {} : { personalitySuffix: suffix }),
      // The A2.1 seam: already scanned, already trusted, rendered once for the STABLE tier.
      ...(workspaceBlock === undefined ? {} : { workspaceContext: workspaceBlock }),
    });
    // [C5 -> W3.1] The held-write session. A memory write a seat made from untrusted context is
    // parked as a durable approval row; deciding one needs this profile and the UNWRAPPED memory
    // adapter, because replaying through the provenance gate that held the write would hold it
    // again. Registered here, on the graph every surface is built on, so `/approvals` and
    // `trent approvals` find it without a field of their own.
    const heldWrites = openHeldWriteSession({ profileDir, memory: fleetMemory.memory });
    // The self-improvement loop: traces from every run, and promoted skills back into every seat.
    const improve = wireImproveLoop({ store, config });
    // OTel export, when config names a collector: composed onto the same bus hook the improve
    // loop uses, so the orchestrator sees one sink and one flush.
    const telemetry = wireTelemetry(config as TelemetrySlice);
    // Push alerts to `gateway.owner`: failures, unanswered gates and budget thresholds ride the
    // same hook, so they see every run this runtime executes.
    const alerts = wireAlerts(config as GatewaySlice, deps.alerts);
    // Run pinning (T4.1): at every `run_start` the live version of each agent is snapshotted into
    // the run, so a promote mid-run changes the next run. Versions live in the durable store's
    // improve tables; a store without them (plain Node) has no versions to pin, and the hook is
    // not composed at all, so the improve hook still reaches the orchestrator unwrapped.
    const improveStore = (store as { improve?: () => ImproveStorePort }).improve?.();
    const versionPins = improveStore === undefined ? undefined : createVersionPinHook({ store: improveStore });
    const busHook = composeBusHooks(
      improve.improve,
      ...(versionPins === undefined ? [] : [versionPins]),
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
    const maxConcurrentRuns = (config as RuntimeSlice).runtime?.max_concurrent_runs;
    // An empty map is the default, and passing it would write an empty bridge variable for nothing.
    const overrides = (config as ModelOverridesSlice).model_overrides;
    const modelOverrides = overrides && Object.keys(overrides).length > 0 ? { overrides } : {};
    // [B2.1] The tiers ride the same block. An empty `models` is no tiers at all, so it is left
    // off entirely and the model dep stays byte-identical to what an untiered profile sent before.
    const tiers = (config as ModelTiersSlice).models;
    const modelTiers = tiers && Object.keys(tiers).length > 0 ? { models: tiers } : {};
    // A variable, not a literal in the call: the tier block is carried to `applyModelEnv`, which
    // reads it, through a dep type that declares provider, model and prices only.
    const model = { provider: config.provider, model: config.model, ...modelOverrides, ...modelTiers };
    const orchestrator = createOrchestrator({
      ...(durable ? { databaseUrl } : {}),
      ...(maxConcurrentRuns === undefined ? {} : { maxConcurrentRuns }),
      model,
      tools: tools.adapters,
      fleetMemory,
      delegate,
      // [C5 -> W3.1] The failure channel's only inlet. `FleetMemoryHook.traceSink` is what turns a
      // failed step into a redacted `[failure]` entry under the brain and records what each step's
      // tool calls were derived from; without this line C5's channel existed and no run ever
      // reached it. It is synchronous, swallows its own errors and never fails a run, so it is
      // composed with any sink the caller injected rather than replacing it.
      traceSink: (event) => {
        fleetMemory.traceSink(event);
        // [G3.1] The same two frames the REPL's ticker and `trent run`'s reader meter, charged to
        // the run's own meter; `closeRunScope` writes them to the day's ledger when the run ends.
        chargeSpend(event);
        deps.traceSink?.(event);
      },
      verification: createGoalVerificationPort(),
      ...improve,
      improve: busHook,
    });
    // `launchOrchestration` throws "Company not found" for an id nothing created; an explicit
    // config id is trusted, otherwise the local company is found by slug or created.
    const configuredId = (config as { company?: { id?: string } }).company?.id;
    const companyId = configuredId !== undefined ? String(configuredId) : await orchestrator.ensureCompany(DEFAULT_COMPANY);

    // A2.2. The session is open: this is the moment `hooks/runner.ts` documents as `session_start`.
    // `runSessionHooks` resolves rather than throws, so a hook can neither stop a session opening
    // nor take it down; what it can do is say, once, that it did not run.
    const hooks = (config as HooksSlice).hooks;
    if (hooks !== undefined) notices.push(...sessionHookNotices(await runSessionHooks("session_start", { profileDir, hooks, cwd: workspace })));
    // `cleanup()` is called on every exit path, and more than once; the stop hooks run on the first.
    let stopped = false;

    return {
      orchestrator,
      companyId,
      workspace: workspaceContext,
      store,
      durable,
      tools,
      fleetMemory,
      improve,
      telemetry,
      alerts,
      versionPins,
      checkpoints,
      goals,
      run: (objective, options = {}) => {
        // [E1] One run is one turn: `trent run`, a cron tick and a heartbeat are each a single
        // checkpoint, and a REPL turn is the run it starts. Opening a turn nothing has written
        // into yet is a no-op, so a surface that also marks its own boundary cannot skip a number.
        checkpoints?.beginTurn();
        // [G3.1] The surface rides the run options because that is where `openRunScope` reads it,
        // and the run's meter is opened there — before any step of it can be billed.
        const surface = options.surface ?? deps.surface;
        return orchestrator.run({
          companyId,
          objective,
          trigger: options.trigger ?? "manual",
          signal: options.signal,
          ...(options.history === undefined ? {} : { history: options.history }),
          ...(surface === undefined ? {} : { surface }),
        });
      },
      notices: () => [...notices, ...tools.hookNotices],
      cleanup: async () => {
        // The shutdown path, in order: the session's own hooks first (they may still want to read
        // what the session wrote), then the alert sender, then the proxy and the sandboxes.
        if (hooks !== undefined && !stopped) {
          stopped = true;
          notices.push(...sessionHookNotices(await runSessionHooks("session_stop", { profileDir, hooks, cwd: workspace })));
        }
        alerts?.close();
        // [G3.1] A charge after this belongs to no surface of this process, so none is recorded.
        spend.close();
        // A held write decided after this belongs to no session's memory adapter, so none is found.
        closeHeldWriteSession(heldWrites);
        // [E1] A write after this belongs to no turn of this session, so it is ledgered into none.
        if (checkpoints !== undefined) closeCheckpointSession(checkpoints);
        // [D4] A gate after this belongs to no goal of this session, and its sandbox goes with it.
        closeGoalSession(goals);
        await goals.cleanup();
        await tools.cleanup();
      },
    };
  } catch (error) {
    // The graph did not come up: the proxy, the sandboxes and the ledger sessions already running
    // must not outlive it.
    spend.close();
    if (checkpoints !== undefined) closeCheckpointSession(checkpoints);
    closeGoalSession(goals);
    await goals.cleanup();
    await tools.cleanup();
    throw error;
  }
}
