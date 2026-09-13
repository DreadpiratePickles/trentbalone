/**
 * Content-addressed memory for the executing gate (item 3.1 of the CS329A analysis).
 *
 * Two kinds of result are worth keeping because the model is run at temperature 0 and the
 * inputs are hashable:
 *   - a measured BASELINE, keyed by (suite id, suite version, judged?, sha256(seat prompt)), so the
 *     seat prompt is executed once per suite version, not once per sweep;
 *   - a JUDGE VERDICT, keyed by (fixture id, sha256(rubric), sha256(output text)), so a candidate
 *     whose output on a fixture is byte-identical to something already judged costs no judge call.
 *
 * The cache stores only scores, tags and verdicts, never a prompt or an output body; the text is
 * present only as a hash. `GateCache` is the small port `gate.ts` needs; `storeGateCache` backs
 * it with the durable store, `createMemoryGateCache` with a Map for tests.
 */

import type { GateCacheRow, ImproveStorePort, JsonValue } from "../store/StorePort.js";
import { contentHash } from "./ledger.js";

export interface GateCache {
  get(key: string): Promise<JsonValue | undefined>;
  put(key: string, value: JsonValue): Promise<void>;
}

/**
 * Bumped when what a cached baseline carries changes shape: v2 added per-fixture pass/fail (I.12)
 * and per-fixture rubric tags (I.9), so a v1 entry would block every candidate as a new cluster.
 */
export const BASELINE_CACHE_SCHEMA = "v2";

export function baselineCacheKey(suiteId: string, suiteVersion: string, judged: boolean, seatPrompt: string): string {
  return `baseline:${BASELINE_CACHE_SCHEMA}:${suiteId}:${suiteVersion}:${judged ? "judged" : "unjudged"}:${contentHash(seatPrompt)}`;
}

export function judgeCacheKey(fixtureId: string, rubric: string, outputText: string): string {
  return `judge:${fixtureId}:${contentHash(rubric)}:${contentHash(outputText)}`;
}

export function createMemoryGateCache(): GateCache & { size(): number } {
  const map = new Map<string, JsonValue>();
  return {
    async get(key) {
      const hit = map.get(key);
      return hit === undefined ? undefined : structuredClone(hit);
    },
    async put(key, value) {
      map.set(key, structuredClone(value));
    },
    size: () => map.size,
  };
}

/** The durable cache: one row per (company, key) in the store's GateCache table. */
export function storeGateCache(store: ImproveStorePort, companyId: string, now: () => string): GateCache {
  return {
    async get(key) {
      const row: GateCacheRow | null = await store.getGateCache(companyId, key);
      return row?.value;
    },
    async put(key, value) {
      await store.putGateCache({ companyId, key, value, createdAt: now() });
    },
  };
}
