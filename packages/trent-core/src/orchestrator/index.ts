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
 *     produces, so a surface can render it as an answerable gate (F4 / D4);
 *   - the self-improvement loop's bus hook (`deps.improve`, see `../improve/hook.ts`): every event
 *     is handed to it and its writes are awaited before the run settles, so traces and failure
 *     goldens are durable by the time a caller sweeps;
 *   - the planner and the critic reach the CONFIGURED provider: the gateway-backed
 *     `createCompletion` port is installed through the overrides seam by default (finding 1 of the
 *     live proof: `callJson` is OpenAI-only, so on Gemini the plan was canned and the critic
 *     auto-passed). A planner failure with a provider configured fails the run instead of
 *     silently substituting the canned plan (`provider-ports.ts`);
 *   - the consolidator has no seam at all (`callText` takes no options), so the wrapper detects
 *     the literal fallback summary on `consolidate_end` and writes the real brief through the
 *     gateway, replacing it in the snapshot, the store and the emitted events.
 */

import { createCompletionPort } from "../model-gateway/completion-port.js";
import { createModelGateway } from "../model-gateway/index.js";
import type { ModelGateway } from "../model-gateway/types.js";
import { IN_MEMORY_DATABASE, applyStandaloneEnv, assertStandaloneEnv } from "../runtime/env.js";
import { EventChannel } from "./event-channel.js";
import { loadLibs, type Libs } from "./libs.js";
import { applyModelEnv } from "./model-env.js";
import { PortShaper, PortTally } from "./provider-ports.js";
import { SeatTally, guardSeatModel, shapeEvent, type SeatModelFn } from "./seat-guard.js";
import { toolInstructions, wireSeatTools } from "./seat-wiring.js";
import type { TrentToolAdapter } from "../tools/types.js";
import {
  type OrcEvent,
  type Orchestrator,
  type OrchestratorDeps,
  type OrchestratorRunHandle,
  type OrchestratorRunOptions,
  type OrchestrationRunSnapshot,
} from "./types.js";

export type * from "./types.js";
export { FALLBACK_PLANNER_APPROVAL_TRIGGERS, FALLBACK_PLAN_REASONING, FALLBACK_RUN_SUMMARY } from "./types.js";
export { buildConsolidationPrompt, isFallbackSummary, WRAPPER_CONSOLIDATED_DETAIL } from "./provider-ports.js";
export { applyModelEnv, modelEnvKeys } from "./model-env.js";
export { resolveToolName, normaliseSeatTurn } from "./tool-names.js";
export { wireSeatTools, toolsetEnvironment, SEAT_ROLES } from "./seat-wiring.js";

/**
 * Default drain bound. A 12-step plan (the planner's Zod maximum) costs one plan job, up to 12
 * execute jobs, up to 12 retries, up to 6 delegated steps and one consolidate job; 60 clears that
 * with margin while still guaranteeing termination if a phase worker ever re-enqueues itself.
 */
export const DEFAULT_MAX_JOBS = 60;

/** A bus hook with a flush the run awaits: what `../improve/hook.ts` builds. */
export interface RunBusHook {
  readonly sink: (event: OrcEvent) => void;
  flush(): Promise<void>;
}

/** `OrchestratorDeps` plus the self-improvement hook. Declared here so `types.ts` stays a pure mirror. */
export type OrchestratorDepsWithImprove = OrchestratorDeps & {
  /** Receives every event and is flushed before `result()` resolves. */
  readonly improve?: RunBusHook;
  /**
   * The toolset adapters the seats may use (`buildTrentToolAdapters(config, ...)`). Registered
   * through the app's `registerExternalAdapters` seam and written into every seat's environment
   * before a run launches; their usage text rides into the seat prompt through the seat guard.
   */
  readonly tools?: readonly TrentToolAdapter[];
};

// --- The drain loop -----------------------------------------------------------------------------

type DrainExit = "drained" | "interrupted" | "bounded";

interface DrainControl {
  isInterrupted(): boolean;
  /** Resolves when approve()/reject()/cancel() or an abort wakes a parked run. */
  waitForResume(): Promise<void>;
  /** Resolves once every event received so far has been shaped, so verdicts made there are visible. */
  settle(): Promise<void>;
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
    await control.settle();
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

export function createOrchestrator(deps: OrchestratorDepsWithImprove = {}): Orchestrator {
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

  /**
   * The gateway the planner, critic and consolidator go through. Built lazily — AFTER the env
   * writes above, because `createModelGateway` imports apps/web and freezes its policy — and once
   * per orchestrator, so every run routes the same way.
   */
  let gatewayPromise: Promise<ModelGateway> | undefined;
  function loadGateway(): Promise<ModelGateway> {
    if (deps.gateway) return Promise.resolve(deps.gateway);
    gatewayPromise ??= createModelGateway();
    return gatewayPromise;
  }

  const seatInstructions = toolInstructions(deps.tools ?? []);

  function installPorts(libs: Libs, gateway: ModelGateway, tally: SeatTally, ports: PortTally): void {
    const underlying = (deps.executeSeatModelFn as SeatModelFn | undefined) ?? libs.gateway.executeSeatModel;
    const chat = deps.executeSeatModelFn ? undefined : deps.createChatCompletion;
    libs.overrides.setRuntimeEvalOverrides({
      orchestration: {
        // Default, not test-only: the planner and the critic reach the configured provider.
        createCompletion: deps.createCompletion ?? createCompletionPort(gateway, { onCall: (call) => ports.record(call) }),
        executeSeatModelFn: guardSeatModel(underlying, chat, tally, seatInstructions),
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

  /**
   * With a provider configured, a planner failure is an error, not a canned plan: the pipeline's
   * `callJsonWithFallback` swallowed it, so the wrapper fails the run — live cache and store — with
   * the provider's own message. Returns the summary written.
   */
  async function applyPlannerFailure(libs: Libs, runId: string, message: string): Promise<{ summary: string; completedAt: string }> {
    const summary = `Run failed: planner call failed: ${message}`;
    const completedAt = new Date().toISOString();
    const live = libs.orchestrator.getOrchestrationRun(runId);
    if (live) {
      live.status = "failed";
      live.summary = summary;
      live.completedAt = live.completedAt ?? completedAt;
      libs.cache.cacheOrchestrationRun(live);
    }
    await libs.store.updateOrchestratorRun(runId, { status: "failed", summary, completedAt }).catch(() => undefined);
    return { summary, completedAt };
  }

  /** Writes the wrapper's consolidated brief where the snapshot and the store read it. */
  async function applyConsolidation(libs: Libs, runId: string, summary: string): Promise<void> {
    const live = libs.orchestrator.getOrchestrationRun(runId);
    if (live) {
      live.summary = summary;
      libs.cache.cacheOrchestrationRun(live);
    }
    await libs.store.updateOrchestratorRun(runId, { summary }).catch(() => undefined);
  }

  function run(options: OrchestratorRunOptions): OrchestratorRunHandle {
    const channel = new EventChannel();
    const maxJobs = options.maxJobs ?? defaultMaxJobs;
    const tally = new SeatTally();
    const ports = new PortTally();
    let shaper: PortShaper | undefined;
    let runId: string | undefined;
    let cancelRequested = false;

    const isInterrupted = (): boolean =>
      cancelRequested || options.signal?.aborted === true || shaper?.plannerFailure !== undefined;

    const deliver = (event: OrcEvent): void => {
      deps.traceSink?.(event);
      deps.improve?.sink(event);
      channel.push(event);
    };

    const started: Promise<string> = (async () => {
      const libs = await loadLibs();
      const gateway = await loadGateway();
      assertStandaloneEnv();
      installPorts(libs, gateway, tally, ports);
      // The seats' tools exist before the plan is made: registry, router catalog, seat environments.
      await wireSeatTools(libs, options.companyId, deps.tools ?? []);
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
            companyId: options.companyId,
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
      const gateway = await loadGateway();
      let unsubscribe: (() => void) | undefined;
      // Events are shaped in order; a consolidation in flight holds everything behind it.
      let chain: Promise<void> = Promise.resolve();
      const enqueue = (work: () => Promise<void>): void => {
        chain = chain.then(work, work);
      };
      try {
        const id = await started;
        const portShaper = new PortShaper(ports, gateway, {
          objective: options.objective,
          liveRun: () => libs.orchestrator.getOrchestrationRun(id),
          persistSummary: (summary) => applyConsolidation(libs, id, summary),
        });
        shaper = portShaper;
        // Subscribed before the first job is drained, so no phase event is lost.
        unsubscribe = libs.events.subscribeOrcEvents(id, (event) => {
          enqueue(async () => {
            const withPorts = await portShaper.shape(event);
            if (!withPorts) return;
            const shaped = shapeEvent(withPorts, tally, portShaper.fallbackPlan);
            if (shaped) deliver(shaped);
          });
        });
        await drainRun(libs, options.companyId, id, maxJobs, {
          isInterrupted,
          waitForResume: () => waitForResume(id, options.signal, isInterrupted),
          settle: () => chain,
        });
        await chain;
        if (portShaper.plannerFailure !== undefined) {
          const { summary, completedAt } = await applyPlannerFailure(libs, id, portShaper.plannerFailure);
          deliver(portShaper.plannerFailedEvent(id, summary, completedAt));
        } else if (portShaper.consolidated !== undefined) {
          await applyConsolidation(libs, id, portShaper.consolidated);
        }
        await applyFailureOverride(libs, id, tally);
        // The loop's writes are part of the run: a caller that sweeps right after must see them.
        await deps.improve?.flush();
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
