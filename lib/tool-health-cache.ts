/**
 * Tool Health Cache — the bridge from the metric monitor to live grounding.
 *
 * The heartbeat self-improvement sweep periodically computes which tools have
 * degraded (lib/tool-health). Live step execution, in a different process path,
 * needs that signal to avoid routing to a known-broken tool — but must not pay a
 * DB round-trip per step to get it.
 *
 * So the sweep (producer) publishes the degraded tool set here, and the
 * orchestrator (consumer) reads it when ranking tools for a step. A short TTL
 * means a tool that recovers stops being avoided once the cache goes stale,
 * without any explicit "all clear" signal. This mirrors the module-level caches
 * already used in agent-runtime (runtimeCache) and semantic-router (sharedVocab).
 *
 * Best-effort and in-memory per process: a miss simply means health-unaware
 * routing (the prior behavior), never an error.
 */

const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1h — the heartbeat cadence.

type Entry = { tools: Set<string>; publishedAt: number };

const cache = new Map<string, Entry>();

/** Sweep publishes the current degraded tool names for a company. */
export function publishDegradedTools(
  companyId: string,
  tools: readonly string[],
  now: number = Date.now(),
): void {
  if (tools.length === 0) {
    cache.delete(companyId);
    return;
  }
  cache.set(companyId, { tools: new Set(tools), publishedAt: now });
}

/**
 * Orchestrator reads the degraded tool set for a company. Returns an empty set
 * when there is no fresh entry — callers then route health-unaware (no change
 * from prior behavior).
 */
export function getDegradedTools(
  companyId: string,
  now: number = Date.now(),
  ttlMs: number = DEFAULT_TTL_MS,
): Set<string> {
  const entry = cache.get(companyId);
  if (!entry) return new Set();
  if (now - entry.publishedAt > ttlMs) {
    cache.delete(companyId);
    return new Set();
  }
  return new Set(entry.tools);
}

/** Test hook — clear all cached health. */
export function clearToolHealthCacheForTests(): void {
  cache.clear();
}
