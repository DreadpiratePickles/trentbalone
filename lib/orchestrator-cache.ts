import type { OrchestrationRun } from "@/lib/orchestrator";

const globalForOrc = globalThis as unknown as { __trentOrcRuns?: Map<string, OrchestrationRun> };
const runs: Map<string, OrchestrationRun> = globalForOrc.__trentOrcRuns ?? new Map();
globalForOrc.__trentOrcRuns = runs;

export function getCachedOrchestrationRun(id: string): OrchestrationRun | undefined {
  return runs.get(id);
}

export function listCachedOrchestrationRuns(companyId: string): OrchestrationRun[] {
  return Array.from(runs.values())
    .filter((run) => run.companyId === companyId)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export function cacheOrchestrationRun(run: OrchestrationRun): void {
  runs.set(run.id, run);
}

export function deleteCachedOrchestrationRun(runId: string): void {
  runs.delete(runId);
}

export function clearOrchestrationRunCache(): void {
  runs.clear();
}
