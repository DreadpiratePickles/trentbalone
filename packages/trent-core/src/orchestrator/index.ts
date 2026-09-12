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
 */

import { IN_MEMORY_DATABASE, applyStandaloneEnv, assertStandaloneEnv } from "../runtime/env.js";
import type {
  OrcEvent,
  Orchestrator,
  OrchestratorDeps,
  OrchestratorRunHandle,
  OrchestratorRunOptions,
  OrchestrationRunSnapshot,
} from "./types.js";

export type * from "./types.js";

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

interface StoreModule {
  readonly store: { listJobRuns(companyId: string): Promise<readonly JobRunRow[]> };
}

interface OrchestratorModule {
  launchOrchestration(opts: {
    companyId: string;
    objective: string;
    trigger?: string;
    fullTeam?: boolean;
  }): Promise<{ id: string }>;
  cancelOrchestration(runId: string): Promise<boolean>;
  approveStep(runId: string, stepId: string): Promise<boolean>;
  rejectStep(runId: string, stepId: string): Promise<boolean>;
  getOrchestrationRunSnapshot(runId: string): Promise<unknown>;
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

interface Libs {
  readonly store: StoreModule["store"];
  readonly orchestrator: OrchestratorModule;
  readonly events: EventsModule;
  readonly queue: QueueModule;
  readonly overrides: OverridesModule;
}

async function loadLibs(): Promise<Libs> {
  // Imported lazily: `applyStandaloneEnv` must have written process.env before `ai-client.ts` is
  // evaluated, because that module freezes its model registry and token limits at import time.
  const [storeMod, orchestratorMod, eventsMod, queueMod, overridesMod] = await Promise.all([
    import("@/lib/store") as unknown as Promise<StoreModule>,
    import("@/lib/orchestrator") as unknown as Promise<OrchestratorModule>,
    import("@/lib/orchestrator-events") as unknown as Promise<EventsModule>,
    import("@/lib/queue") as unknown as Promise<QueueModule>,
    import("@/lib/runtime-eval-overrides") as unknown as Promise<OverridesModule>,
  ]);
  return {
    store: storeMod.store,
    orchestrator: orchestratorMod,
    events: eventsMod,
    queue: queueMod,
    overrides: overridesMod,
  };
}

// --- A push queue that a consumer can pull from with `for await` ------------------------------

class EventChannel {
  #buffer: OrcEvent[] = [];
  #waiters: Array<(result: IteratorResult<OrcEvent>) => void> = [];
  #closed = false;

  push(event: OrcEvent): void {
    if (this.#closed) return;
    const waiter = this.#waiters.shift();
    if (waiter) waiter({ value: event, done: false });
    else this.#buffer.push(event);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) {
      waiter({ value: undefined, done: true });
    }
  }

  async *iterate(): AsyncGenerator<OrcEvent, void, undefined> {
    for (;;) {
      const buffered = this.#buffer.shift();
      if (buffered) {
        yield buffered;
        continue;
      }
      if (this.#closed) return;
      const next = await new Promise<IteratorResult<OrcEvent>>((resolve) => {
        this.#waiters.push(resolve);
      });
      if (next.done) return;
      yield next.value;
    }
  }
}

// --- The drain loop -----------------------------------------------------------------------------

/**
 * Executes queued orchestration jobs until the run is finished, the bound is reached, or the caller
 * interrupts. Ported from `orchestration-eval-integration.ts:126-144` and extended with the three
 * exits a long-lived CLI needs.
 *
 * @returns why the loop stopped, for the caller's diagnostics.
 */
async function drainRun(
  libs: Libs,
  companyId: string,
  runId: string,
  maxJobs: number,
  isInterrupted: () => boolean,
): Promise<"drained" | "interrupted" | "bounded"> {
  for (let i = 0; i < maxJobs; i += 1) {
    if (isInterrupted()) return "interrupted";

    const next = (await libs.store.listJobRuns(companyId))
      .filter((job) => job.type === "orchestration_step" && job.status === "running")
      .filter((job) => job.metadata?.runId === runId)
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt))[0];
    if (!next) return "drained";

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
      if (isInterrupted()) return "interrupted";
      throw error;
    }
  }
  return "bounded";
}

// --- Public factory -----------------------------------------------------------------------------

export function createOrchestrator(deps: OrchestratorDeps = {}): Orchestrator {
  // Must happen before any apps/web module is imported. Without TRENT_QUEUE_FALLBACK=disabled the
  // inline fallback races this drain loop and every job executes twice, silently.
  applyStandaloneEnv(deps.databaseUrl ?? IN_MEMORY_DATABASE);
  assertStandaloneEnv();

  const defaultMaxJobs = deps.maxJobs ?? DEFAULT_MAX_JOBS;

  function installPorts(libs: Libs): boolean {
    if (!deps.createCompletion && !deps.executeSeatModelFn) return false;
    libs.overrides.setRuntimeEvalOverrides({
      orchestration: {
        createCompletion: deps.createCompletion,
        executeSeatModelFn: deps.executeSeatModelFn,
      },
    });
    return true;
  }

  async function snapshotOf(libs: Libs, runId: string): Promise<OrchestrationRunSnapshot | undefined> {
    const raw = await libs.orchestrator.getOrchestrationRunSnapshot(runId);
    return raw as OrchestrationRunSnapshot | undefined;
  }

  function run(options: OrchestratorRunOptions): OrchestratorRunHandle {
    const channel = new EventChannel();
    const maxJobs = options.maxJobs ?? defaultMaxJobs;
    let runId: string | undefined;
    let cancelRequested = false;

    const isInterrupted = (): boolean => cancelRequested || options.signal?.aborted === true;

    const started: Promise<string> = (async () => {
      const libs = await loadLibs();
      assertStandaloneEnv();
      const installed = installPorts(libs);
      try {
        const launched = await libs.orchestrator.launchOrchestration({
          companyId: options.companyId,
          objective: options.objective,
          trigger: options.trigger ?? "manual",
          fullTeam: options.fullTeam ?? false,
        });
        runId = launched.id;
        return launched.id;
      } catch (error) {
        if (installed) libs.overrides.clearRuntimeEvalOverrides();
        throw error;
      }
    })();

    const finished: Promise<OrchestrationRunSnapshot> = (async () => {
      const libs = await loadLibs();
      let unsubscribe: (() => void) | undefined;
      const installed = deps.createCompletion !== undefined || deps.executeSeatModelFn !== undefined;
      try {
        const id = await started;
        // Subscribed before the first job is drained, so no phase event is lost. `run_start` fires
        // inside launchOrchestration and is therefore intentionally not part of this stream.
        unsubscribe = libs.events.subscribeOrcEvents(id, (event) => {
          deps.traceSink?.(event);
          channel.push(event);
        });
        await drainRun(libs, options.companyId, id, maxJobs, isInterrupted);
        const snapshot = await snapshotOf(libs, id);
        if (!snapshot) throw new Error(`Orchestration run ${id} vanished before a snapshot could be read`);
        return snapshot;
      } finally {
        unsubscribe?.();
        channel.close();
        if (installed) libs.overrides.clearRuntimeEvalOverrides();
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
        return libs.orchestrator.cancelOrchestration(id);
      },
    };
    return handle;
  }

  return {
    run,
    snapshot: async (runId) => snapshotOf(await loadLibs(), runId),
    approve: async (runId, stepId) => (await loadLibs()).orchestrator.approveStep(runId, stepId),
    reject: async (runId, stepId) => (await loadLibs()).orchestrator.rejectStep(runId, stepId),
  };
}
