/**
 * The sweep's baseline, content-addressed (CS329A analysis 3.1): keyed by
 * (suite id, suite version, judged?, sha256(seat prompt)) in the store's GateCache, so a seat
 * prompt is executed once per suite version, not once per sweep. The cached row carries the
 * score, the failure clusters and the per-fixture pass/fail the re-draw needs (I.12); a row from
 * an older schema is simply not a hit (`BASELINE_CACHE_SCHEMA`).
 */

import type { JsonValue } from "../store/StorePort.js";
import { baselineCacheKey, type GateCache } from "./gate-cache.js";
import { measureBaseline, type ActualsRunner, type GateBaseline, type JudgeFn } from "./gate.js";
import type { SweepMeter } from "./meter.js";
import type { FrozenSuite } from "./suites.js";

export interface BaselineLookup {
  readonly suite: FrozenSuite | undefined;
  readonly actuals: ActualsRunner | undefined;
  readonly judge: JudgeFn | undefined;
  readonly cache: GateCache;
  readonly meter: SweepMeter;
  readonly seatPrompt: () => Promise<string>;
}

function isBaselineFixture(value: JsonValue): value is { id: string; passed: boolean } {
  return typeof value === "object" && value !== null && !Array.isArray(value) && typeof value.id === "string" && typeof value.passed === "boolean";
}

/** A cached baseline row back into a `GateBaseline`; undefined when the row is not one. */
export function baselineFromCache(hit: JsonValue | undefined): GateBaseline | undefined {
  if (hit === undefined || typeof hit !== "object" || hit === null || Array.isArray(hit) || typeof hit.score !== "number") return undefined;
  const clusters = hit.failureClusters;
  const fixtures = Array.isArray(hit.fixtures) ? hit.fixtures.filter(isBaselineFixture) : undefined;
  return {
    score: hit.score,
    failureClusters: clusters !== null && typeof clusters === "object" && !Array.isArray(clusters) ? (clusters as Record<string, number>) : {},
    ...(fixtures === undefined ? {} : { fixtures }),
  };
}

/** The cached baseline when there is one, else measured under the `baseline` phase and cached. */
export async function cachedOrMeasuredBaseline(input: BaselineLookup): Promise<GateBaseline | undefined> {
  const { suite, actuals, judge } = input;
  if (!suite || !actuals) return undefined;
  const seatPrompt = await input.seatPrompt();
  const key = baselineCacheKey(suite.id, suite.version, judge !== undefined, seatPrompt);
  const cached = baselineFromCache(await input.cache.get(key));
  if (cached) return cached;
  const measured = await input.meter.within("baseline", () =>
    measureBaseline({ seatPrompt, suite, actuals, cache: input.cache, ...(judge === undefined ? {} : { judge }) }),
  );
  await input.cache.put(key, { score: measured.score, failureClusters: measured.failureClusters, fixtures: measured.fixtures.map((f) => ({ ...f })) });
  return { score: measured.score, failureClusters: measured.failureClusters, fixtures: measured.fixtures };
}
