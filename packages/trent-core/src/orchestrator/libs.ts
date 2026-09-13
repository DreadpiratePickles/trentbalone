/**
 * Structural views of the wrapped `apps/web` modules, and their lazy loader.
 *
 * Declared locally and cast at the single `await import` boundary, so `tsc` never has to load the
 * apps/web type graph to type-check this package. The imports are lazy on purpose: `applyStandaloneEnv`
 * and `applyModelEnv` must have written process.env before `ai-client.ts` is evaluated, because that
 * module freezes its model registry and token limits at import time.
 */

import type { OrcEvent } from "./types.js";
import type { SeatModelFn } from "./seat-guard.js";

export interface JobRunRow {
  readonly id: string;
  readonly type: string;
  readonly status: string;
  readonly startedAt: string;
  readonly metadata?: { runId?: string; action?: string; stepId?: string } | null;
}

export interface CompanyRow {
  readonly id: string;
  readonly slug: string;
}

export interface StoreModule {
  readonly store: {
    listCompanies(): Promise<readonly CompanyRow[]>;
    createCompany(input: { name: string; brief: { vision: string } }): Promise<CompanyRow>;
    listJobRuns(companyId: string): Promise<readonly JobRunRow[]>;
    updateOrchestratorRun(id: string, patch: { status?: string; summary?: string; completedAt?: string }): Promise<unknown>;
  };
}

export interface LaunchedRun {
  readonly id: string;
  readonly objective: string;
  readonly status: string;
  readonly trigger: string;
  readonly startedAt: string;
}

/** The live, mutable run object the pipeline caches; mutations are visible to the next snapshot. */
export interface LiveRun {
  objective: string;
  status: string;
  summary?: string;
  completedAt?: string;
  plan?: { objective: string; successCriteria?: string[] };
  steps: Array<{ id: string; title: string; agentRole?: string; status: string; output?: string; completedAt?: string }>;
}

export interface OrchestratorModule {
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

export interface CacheModule {
  cacheOrchestrationRun(run: LiveRun): void;
}

export interface EventsModule {
  subscribeOrcEvents(runId: string, listener: (event: OrcEvent) => void): () => void;
}

export interface QueueModule {
  processJobData(
    type: string,
    data: { jobRunId: string; companyId: string; runId: string; action?: string; stepId?: string },
  ): Promise<unknown>;
}

export interface OverridesModule {
  setRuntimeEvalOverrides(overrides: {
    orchestration?: { createCompletion?: unknown; executeSeatModelFn?: unknown };
  } | null): void;
  clearRuntimeEvalOverrides(): void;
}

export interface GatewayModule {
  executeSeatModel: SeatModelFn;
}

export interface Libs {
  readonly store: StoreModule["store"];
  readonly orchestrator: OrchestratorModule;
  readonly cache: CacheModule;
  readonly events: EventsModule;
  readonly queue: QueueModule;
  readonly overrides: OverridesModule;
  readonly gateway: GatewayModule;
}

export async function loadLibs(): Promise<Libs> {
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
