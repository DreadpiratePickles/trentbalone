export const MAX_CONCURRENT_RUNS_PER_KEY = 3;

const activeRunsByKey = new Map<string, Set<string>>();

export function activeRunCountForKey(keyId: string): number {
  return activeRunsByKey.get(keyId)?.size ?? 0;
}

export function trackMcpRun(keyId: string, runId: string): void {
  const runs = activeRunsByKey.get(keyId) ?? new Set<string>();
  runs.add(runId);
  activeRunsByKey.set(keyId, runs);
}

export function releaseMcpRun(keyId: string, runId: string): void {
  const runs = activeRunsByKey.get(keyId);
  if (!runs) return;
  runs.delete(runId);
  if (!runs.size) activeRunsByKey.delete(keyId);
}

export function resetMcpRunTrackingForTest(): void {
  activeRunsByKey.clear();
}
