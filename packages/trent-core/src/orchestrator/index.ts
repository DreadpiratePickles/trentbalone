/**
 * Orchestrator wrapper — the single-call abstraction the CLI, TUI and Desktop surfaces need.
 *
 * `apps/web/lib/orchestrator.ts` exposes no `runOrchestration()`. `launchOrchestration()` creates the
 * run row, emits `run_start` and ENQUEUES a plan job; the pipeline then advances one queued job at a
 * time and the CALLER must drain the queue. Only the eval harness
 * (`apps/web/lib/orchestration-eval-integration.ts:126-144`) ever did that, and it is not a library.
 * This module owns the drain loop, subscribes to the in-process event bus, and hands back an
 * async-iterable handle.
 *
 * `apps/web/` is read-only: nothing here modifies it. The model ports are injected through the
 * existing DI seam (`lib/runtime-eval-overrides.ts`), never by mocking modules.
 *
 * What the wrapper adds on top of the raw pipeline (each from the live proof,
 * `04_verification/output/live-agents-and-tools.md` §4):
 *   - config -> env for the model resolver, before the libs load (F2 / D1a, `model-env.ts`);
 *   - a seat guard port that records every seat model call, so a run whose every call failed at the
 *     provider ends `failed` with the provider's message instead of `completed` (F2 / D1b);
 *   - the same port normalises split tool names (`{name:"memory",action:"read"}` -> `memory:read`)
 *     when unambiguous (F3, `tool-names.ts`);
 *   - `run_start` synthesised from the launch result, since the bus emits it before anyone can
 *     subscribe (F5 / D2);
 *   - the drain loop WAITS while the run is parked on an approval and resumes after `approve()` /
 *     `reject()`, instead of closing the handle (D2);
 *   - an explanation on the `*_awaiting_approval` events the fallback planner's keyword gate
 *     produces, so a surface can render it as an answerable gate (F4 / D4).
 */

import { IN_MEMORY_DATABASE, applyStandaloneEnv, assertStandaloneEnv } from "../runtime/env.js";
import { EventChannel } from "./event-channel.js";
import { applyModelEnv } from "./model-env.js";
import { SeatTally, guardSeatModel, shapeEvent, type SeatModelFn } from "./seat-guard.js";
import {
  FALLBACK_PLAN_REASONING,
  type OrcEvent,
  type Orchestrator,
  type OrchestratorDeps,
  type OrchestratorRunHandle,
  type OrchestratorRunOptions,
  type OrchestrationRunSnapshot,
} from "./types.js";

export type * from "./types.js";
export { FALLBACK_PLANNER_APPROVAL_TRIGGERS, FALLBACK_PLAN_REASONING } from "./types.js";
export { applyModelEnv, modelEnvKeys } from "./model-env.js";
export { resolveToolName, normaliseSeatTurn } from "./tool-names.js";

/**
 * Default drain bound. A 12-step plan (the planner's Zod maximum) costs one plan job, up to 12
 * execute jobs, up to 12 retries, up to 6 delegated steps and one consolidate job; 60 clears that
 * with margin while still guaranteeing termination if a phase worker ever re-enqueues itself.
 */
export const DEFAULT_MAX_JOBS = 60;

// --- Structural views of the wrapped modules ------------------------------------------------
// Declared locally and cast at the single `await import` boundary below, so `tsc` never has to load
// the apps/web type graph to type-check this package.

interface JobRunRow {
  readonly id: string;
  readonly type: string;
  readonly status: string;
  readonly startedAt: string;
  readonly metadata?: { runId?: string; action?: string; stepId?: string } | null;
}

interface CompanyRow {
  readonly id: string;
  readonly slug: string;
}

interface StoreModule {
  readonly store: {
    listCompanies(): Promise<readonly CompanyRow[]>;
    createCompany(input: { name: string; brief: { vision: string } }): Promise<CompanyRow>;
    listJobRuns(companyId: string): Promise<readonly JobRunRow[]>;
    updateOrchestratorRun(id: string, patch: { status?: string; summary?: string; completedAt?: string }): Promise<unknown>;
  };
}

interface LaunchedRun {
  readonly id: string;
  readonly objective: string;
  readonly status: string;
  readonly trigger: string;
  readonly startedAt: string;
}

/** The live, mutable run object the pipeline caches; mutations are visible to the next snapshot. */
interface LiveRun {
  status: string;
  summary?: string;
  completedAt?: string;
  steps: Array<{ id: string; status: string; output?: string; completedAt?: string }>;
}

interface OrchestratorModule {
  launchOrchestration(opts: {
    companyId: string;
    objective: string;
    trigger?: string;
    fullTeam?: boolean;
  }): Promise<LaunchedRun>;
  cancelOrchestration(runId: string): Promise<boolean>;
  approveStep(runId: string, stepId: string): Promise<boolean>;
  rejectStep(runId: string, stepId: string): Promise<boolean>;
  getOrchestrationRunSnapshot(runId: string): Promise<unknown>;
  getOrchestrationRun(runId: string): LiveRun | undefined;
}

interface CacheModule {
  cacheOrchestrationRun(run: LiveRun): void;
}

interface EventsModule {
  subscribeOrcEvents(runId: string, listener: (event: OrcEvent) => void): () => void;
}

interface QueueModule {
  processJobData(
    type: string,
    data: { jobRunId: string; companyId: string; runId: string; action?: string; stepId?: string },
  ): Promise<unknown>;
}

interface OverridesModule {
  setRuntimeEvalOverrides(overrides: {
    orchestration?: { createCompletion?: unknown; executeSeatModelFn?: unknown };
  } | null): void;
  clearRuntimeEvalOverrides(): void;
}

interface GatewayModule {
  executeSeatModel: SeatModelFn;
}

interface Libs {
  readonly store: StoreModule["store"];
  readonly orchestrator: OrchestratorModule;
  readonly cache: CacheModule;
  readonly events: EventsModule;
  readonly queue: QueueModule;
  readonly overrides: OverridesModule;
  readonly gateway: GatewayModule;
}

async function loadLibs(): Promise<Libs> {
  // Imported lazily: `applyStandaloneEnv` and `applyModelEnv` must have written process.env before
  // `ai-client.ts` is evaluated, because that module freezes its model registry and token limits at
  // import time.
  const [storeMod, orchestratorMod, cacheMod, eventsMod, queueMod, overridesMod, gatewayMod] = await Promise.all([
    import("@/lib/store") as unknown as Promise<StoreModule>,
    import("@/lib/orchestrator") as unknown as Promise<OrchestratorModule>,
    import("@/lib/orchestrator-cache") as unknown as Promise<CacheModule>,
    import("@/lib/orchestrator-events") as unknown as Promise<EventsModule>,
    import("@/lib/queue") as unknown as Promise<QueueModule>,
    import("@/lib/runtime-eval-overrides") as unknown as Promise<OverridesModule>,
    import("@/lib/model-gateway") as unknown as Promise<GatewayModule>,
  ]);
  return {
    store: storeMod.store,
    orchestrator: orchestratorMod,
    cache: cacheMod,
    events: eventsMod,
    queue: queueMod,
    overrides: overridesMod,
    gateway: gatewayMod,
  };
}

// --- The drain loop -----------------------------------------------------------------------------

type DrainExit = "drained" | "interrupted" | "bounded";

interface DrainControl {
  isInterrupted(): boolean;
  /** Resolves when approve()/reject()/cancel() or an abort wakes a parked run. */
  waitForResume(): Promise<void>;
}

/**
 * Executes queued orchestration jobs until the run is finished, the bound is reached, or the caller
 * interrupts. Ported from `orchestration-eval-integration.ts:126-144` and extended with the three
 * exits a long-lived CLI needs, plus the approval wait: when the queue is empty because the run is
 * parked on a human decision, the loop waits for `approve()`/`reject()` rather than returning.
 *
 * @returns why the loop stopped, for the caller's diagnostics.
 */
async function drainRun(libs: Libs, companyId: string, runId: string, maxJobs: number, control: DrainControl): Promise<DrainExit> {
  for (let i = 0; i < maxJobs; i += 1) {
    if (control.isInterrupted()) return "interrupted";

    const next = (await libs.store.listJobRuns(companyId))
      .filter((job) => job.type === "orchestration_step" && job.status === "running")
      .filter((job) => job.metadata?.runId === runId)
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt))[0];
    if (!next) {
      const live = libs.orchestrator.getOrchestrationRun(runId);
      if (live?.status !== "awaiting_approval") return "drained";
      await control.waitForResume();
      continue;
    }

    try {
      await libs.queue.processJobData("orchestration_step", {
        jobRunId: next.id,
        companyId,
        runId,
        action: next.metadata?.action,
        stepId: next.metadata?.stepId,
      });
    } catch (error) {
      // A cancelled run makes the in-flight worker throw; that is the interruption, not a fault.
      if (control.isInterrupted()) return "interrupted";
      throw error;
    }
  }
  return "bounded";
}

/** The same shape `apps/web/lib/store` derives from a company name, so the lookup round-trips. */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)+/g, "")
    .slice(0, 48);
}

// --- Public factory -----------------------------------------------------------------------------

export function createOrchestrator(deps: OrchestratorDeps = {}): Orchestrator {
  // Must happen before any apps/web module is imported. Without TRENT_QUEUE_FALLBACK=disabled the
  // inline fallback races this drain loop and every job executes twice, silently.
  applyStandaloneEnv(deps.databaseUrl ?? IN_MEMORY_DATABASE);
  // Same rule for the model resolver: the configured model has to be in the env before the libs load.
  applyModelEnv(deps.model);
  assertStandaloneEnv();

  const defaultMaxJobs = deps.maxJobs ?? DEFAULT_MAX_JOBS;

  /** Parked runs waiting for approve()/reject()/cancel(), by run id. */
  const resumers = new Map<string, Set<() => void>>();
  function wake(runId: string): void {
    for (const resume of resumers.get(runId) ?? []) resume();
  }
  function waitForResume(runId: string, signal: AbortSignal | undefined, isInterrupted: () => boolean): Promise<void> {
    if (isInterrupted()) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const set = resumers.get(runId) ?? new Set<() => void>();
      resumers.set(runId, set);
      const done = (): void => {
        set.delete(done);
        if (set.size === 0) resumers.delete(runId);
        signal?.removeEventListener("abort", done);
        resolve();
      };
      set.add(done);
      signal?.addEventListener("abort", done, { once: true });
    });
  }

  function installPorts(libs: Libs, tally: SeatTally): void {
    const underlying = (deps.executeSeatModelFn as SeatModelFn | undefined) ?? libs.gateway.executeSeatModel;
    const chat = deps.executeSeatModelFn ? undefined : deps.createChatCompletion;
    libs.overrides.setRuntimeEvalOverrides({
      orchestration: {
        createCompletion: deps.createCompletion,
        executeSeatModelFn: guardSeatModel(underlying, chat, tally),
      },
    });
  }

  async function snapshotOf(libs: Libs, runId: string): Promise<OrchestrationRunSnapshot | undefined> {
    const raw = await libs.orchestrator.getOrchestrationRunSnapshot(runId);
    return raw as OrchestrationRunSnapshot | undefined;
  }

  /**
   * D1b: the pipeline marks a step `completed` even when its seat never reached a model (the seat
   * loop turns a provider error into the summary "Model returned an invalid tool-use turn." and the
   * offline critic auto-passes). When the guard saw every call fail, the run is failed here — in the
   * live cache the snapshot reads from AND in the store — with the provider's own message.
   */
  async function applyFailureOverride(libs: Libs, runId: string, tally: SeatTally): Promise<void> {
    const runFailure = tally.runFailure();
    if (runFailure === undefined) return;
    const summary = `Run failed: every model call failed: ${runFailure}`;
    const completedAt = new Date().toISOString();
    const live = libs.orchestrator.getOrchestrationRun(runId);
    if (live) {
      live.status = "failed";
      live.summary = summary;
      live.completedAt = live.completedAt ?? completedAt;
      for (const step of live.steps) {
        const stepFailure = tally.stepFailure(step.id);
        if (stepFailure === undefined) continue;
        step.status = "failed";
        step.output = `Model call failed: ${stepFailure}`;
      }
      libs.cache.cacheOrchestrationRun(live);
    }
    await libs.store.updateOrchestratorRun(runId, { status: "failed", summary, completedAt }).catch(() => undefined);
  }

  function run(options: OrchestratorRunOptions): OrchestratorRunHandle {
    const channel = new EventChannel();
    const maxJobs = options.maxJobs ?? defaultMaxJobs;
    const tally = new SeatTally();
    let runId: string | undefined;
    let cancelRequested = false;
    let fallbackPlan = false;

    const isInterrupted = (): boolean => cancelRequested || options.signal?.aborted === true;

    const deliver = (event: OrcEvent): void => {
      deps.traceSink?.(event);
      channel.push(event);
    };

    const started: Promise<string> = (async () => {
      const libs = await loadLibs();
      assertStandaloneEnv();
      installPorts(libs, tally);
      try {
        const launched = await libs.orchestrator.launchOrchestration({
          companyId: options.companyId,
          objective: options.objective,
          trigger: options.trigger ?? "manual",
          fullTeam: options.fullTeam ?? false,
        });
        runId = launched.id;
        // The bus emits run_start inside launchOrchestration, before anyone can subscribe. The
        // launch result carries the same fields, so the stream starts with it after all (D2).
        deliver({
          kind: "run_start",
          runId: launched.id,
          at: launched.startedAt,
          run: {
            id: launched.id,
            objective: launched.objective,
            status: launched.status as OrchestrationRunSnapshot["status"],
            trigger: launched.trigger as OrchestrationRunSnapshot["trigger"],
          },
        });
        return launched.id;
      } catch (error) {
        libs.overrides.clearRuntimeEvalOverrides();
        throw error;
      }
    })();

    const finished: Promise<OrchestrationRunSnapshot> = (async () => {
      const libs = await loadLibs();
      let unsubscribe: (() => void) | undefined;
      try {
        const id = await started;
        // Subscribed before the first job is drained, so no phase event is lost.
        unsubscribe = libs.events.subscribeOrcEvents(id, (event) => {
          if (event.kind === "plan_end" && event.run?.plan?.reasoning === FALLBACK_PLAN_REASONING) fallbackPlan = true;
          const shaped = shapeEvent(event, tally, fallbackPlan);
          if (shaped) deliver(shaped);
        });
        await drainRun(libs, options.companyId, id, maxJobs, {
          isInterrupted,
          waitForResume: () => waitForResume(id, options.signal, isInterrupted),
        });
        await applyFailureOverride(libs, id, tally);
        const snapshot = await snapshotOf(libs, id);
        if (!snapshot) throw new Error(`Orchestration run ${id} vanished before a snapshot could be read`);
        return snapshot;
      } finally {
        unsubscribe?.();
        channel.close();
        libs.overrides.clearRuntimeEvalOverrides();
      }
    })();
    // The handle exposes this through result(); nothing is unhandled if the caller only iterates.
    finished.catch(() => undefined);

    const handle: OrchestratorRunHandle = {
      get runId(): string {
        if (!runId) {
          throw new Error("runId is not available until the run has started; await handle.started");
        }
        return runId;
      },
      started,
      [Symbol.asyncIterator]: () => channel.iterate(),
      result: () => finished,
      cancel: async () => {
        cancelRequested = true;
        const id = await started;
        const libs = await loadLibs();
        const cancelled = await libs.orchestrator.cancelOrchestration(id);
        wake(id);
        return cancelled;
      },
    };
    return handle;
  }

  return {
    run,
    ensureCompany: async (input) => {
      const libs = await loadLibs();
      const slug = (input.slug ?? slugify(input.name)).toLowerCase();
      const existing = (await libs.store.listCompanies()).find((company) => company.slug.toLowerCase() === slug);
      if (existing) return existing.id;
      const created = await libs.store.createCompany({ name: input.name, brief: { vision: input.vision ?? input.name } });
      return created.id;
    },
    snapshot: async (runId) => snapshotOf(await loadLibs(), runId),
    approve: async (runId, stepId) => {
      const ok = await (await loadLibs()).orchestrator.approveStep(runId, stepId);
      wake(runId);
      return ok;
    },
    reject: async (runId, stepId) => {
      const ok = await (await loadLibs()).orchestrator.rejectStep(runId, stepId);
      wake(runId);
      return ok;
    },
  };
}
