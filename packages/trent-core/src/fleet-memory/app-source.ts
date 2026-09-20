/**
 * The app-backed `FleetMemorySource`: the company's own store, read through the read-only web
 * modules exactly as `../orchestrator/libs.ts` does — structural types, one lazy `import` per
 * module, after `applyStandaloneEnv` has run. Nothing in `apps/web` is modified.
 *
 * Runs come from `listOrchestrationRunSnapshots` (live cache plus the persisted OrchestratorRun /
 * OrchestratorStep rows), so a run that finished in this process or a previous one is equally
 * visible. Skills come from the improve tables on the same database (`store.improve()`), when the
 * caller attaches one. The playbook is the reflection loop's folded log.
 *
 * [C1] The app's tiered company memory (`listAppMemory`) consults the one store predicate
 * (`app-store.ts`) before any import and answers nothing on a profile whose app store is not
 * usable. The runs and the playbook are NOT gated: they are the run-derived recall that remains
 * when the tiers are skipped, and the modules they read are the ones the orchestrator has already
 * loaded for the run that is asking.
 */

import type { ImproveStorePort } from "../store/StorePort.js";
import type { AppStoreEnv } from "./app-store.js";
import { createAppMemoryReader, type AppMemoryBudgets, type AppMemoryReader } from "./app-tiers.js";
import type { FleetMemorySource, FleetPlaybookEntry, FleetRun } from "./source.js";

interface AppRunSnapshot {
  readonly id: string;
  readonly companyId: string;
  readonly objective: string;
  readonly status: string;
  readonly summary?: string;
  readonly completedAt?: string;
  readonly steps: ReadonlyArray<{ id: string; title: string; agentRole: string; status: string; output?: string }>;
}

interface AppOrchestratorModule {
  listOrchestrationRunSnapshots(companyId: string): Promise<readonly AppRunSnapshot[]>;
}

interface AppPlaybookModule {
  getCompanyPlaybookLog(): { list(companyId: string): Promise<ReadonlyArray<{ topic: string; text: string; status: string }>> };
}

export interface AppFleetSourceOptions {
  readonly improve?: ImproveStorePort;
  /** [C1] Config `memory.app_sources`: characters of candidate text per app surface. */
  readonly appMemoryBudgets?: AppMemoryBudgets;
  /** [C1] The company-memory reader; the real one over `app-tiers.ts` when omitted (tests inject). */
  readonly appMemory?: AppMemoryReader;
  /** [C1] Where the real reader reads `DATABASE_URL` for the store predicate; `process.env` when omitted. */
  readonly env?: AppStoreEnv;
}

export function createAppFleetSource(options: AppFleetSourceOptions = {}): FleetMemorySource {
  let orchestrator: Promise<AppOrchestratorModule> | undefined;
  let playbook: Promise<AppPlaybookModule> | undefined;
  // [C1] The company's own tiered memory: `Document` rows with validity windows are the truth for
  // facts, so a seat reads them here rather than inferring facts from older step outputs.
  const appMemory =
    options.appMemory ??
    createAppMemoryReader({
      ...(options.appMemoryBudgets === undefined ? {} : { budgets: options.appMemoryBudgets }),
      ...(options.env === undefined ? {} : { env: options.env }),
    });
  return {
    improve: options.improve,
    listAppMemory: (companyId, seat) => appMemory(companyId, seat),
    async listRuns(companyId) {
      orchestrator ??= import("@/lib/orchestrator") as unknown as Promise<AppOrchestratorModule>;
      const runs = await (await orchestrator).listOrchestrationRunSnapshots(companyId);
      return runs.map<FleetRun>((run) => ({
        id: run.id,
        companyId: run.companyId,
        objective: run.objective,
        status: run.status,
        summary: run.summary ?? null,
        completedAt: run.completedAt ?? null,
        steps: run.steps.map((step) => ({
          id: step.id,
          runId: run.id,
          agentRole: step.agentRole,
          title: step.title,
          status: step.status,
          output: step.output ?? null,
        })),
      }));
    },
    async listPlaybook(companyId): Promise<readonly FleetPlaybookEntry[]> {
      playbook ??= import("@/lib/self-improvement/company-playbook-log") as unknown as Promise<AppPlaybookModule>;
      const entries = await (await playbook).getCompanyPlaybookLog().list(companyId).catch(() => []);
      // Latest-wins fold by topic, deprecated rows excluded: the same view the seat prompt gets.
      const folded = new Map<string, string>();
      for (const entry of entries) {
        if (entry.status === "deprecated") continue;
        if (entry.text.trim()) folded.set(entry.topic, entry.text);
        else folded.delete(entry.topic);
      }
      return [...folded.entries()].map(([topic, text]) => ({ topic, text }));
    },
  };
}
