/**
 * Public/private suite split (task I.16; CS329A L4 @31:33 RLEF: public tests for iteration,
 * private tests for the reward; L7 @36:21: the scorer must not train on what it ranks).
 *
 * Every fixture is scored by the gate. Only PUBLIC fixtures' failures reach the GEPA reflection,
 * so a prompt cannot be tuned to the whole test. The split is deterministic per fixture: the
 * first byte of sha256(fixture id) puts about 30 percent of ids in the private set, so the same
 * suite splits the same way on every machine and every sweep. A fixture's own `private` flag (set
 * by hand, or by the mechanical overlay's `private: [ids]`) overrides the hash.
 *
 * A candidate that lifts public fixtures and drops a private one the baseline passed is blocked
 * `private_regression` by `gate.ts`, before the ordinary regression and cluster checks, so the
 * reason a human reads is the specific one.
 */

import { createHash } from "node:crypto";

import { buildReflectionPrompt } from "../gepa/index.js";
import type { TraceRecord } from "../traces/trace-store.js";
import type { GateBaseline, GateVerdict } from "./gate-types.js";
import type { FrozenFixture, FrozenSuite } from "./suites.js";

/** Fraction of fixtures the hash holds private when nothing says otherwise. */
export const PRIVATE_SHARE = 0.3;

export function isPrivateFixture(fixture: FrozenFixture): boolean {
  if (fixture.private !== undefined) return fixture.private;
  const byte = createHash("sha256").update(fixture.id, "utf8").digest()[0] ?? 0;
  return byte < Math.round(PRIVATE_SHARE * 256);
}

export interface SuiteSplit {
  public: FrozenFixture[];
  private: FrozenFixture[];
}

export function splitSuite(suite: FrozenSuite): SuiteSplit {
  const split: SuiteSplit = { public: [], private: [] };
  for (const fixture of suite.fixtures) (isPrivateFixture(fixture) ? split.private : split.public).push(fixture);
  return split;
}

/** Private fixture ids the baseline passed and this verdict failed. Empty without per-fixture baseline data. */
export function privateRegressions(suite: FrozenSuite, baseline: GateBaseline, verdict: GateVerdict): string[] {
  if (!baseline.fixtures) return [];
  const before = new Map(baseline.fixtures.map((f) => [f.id, f.passed] as const));
  const privateIds = new Set(splitSuite(suite).private.map((f) => f.id));
  return verdict.fixtures.filter((f) => privateIds.has(f.id) && before.get(f.id) === true && !f.passed).map((f) => f.id);
}

const RESPOND_MARKER = "\nRespond with JSON:";

/**
 * The reflection prompt with the baseline's failing PUBLIC fixtures appended as a section, so the
 * reflection can see what the suite asks and where the current prompt falls short, and never a
 * private fixture's id or text. The lib's prompt is the app's; the section is inserted ahead of
 * its response instructions. The result is sent to a model and must never be logged.
 */
export function buildPublicReflectionPrompt(
  role: TraceRecord["agentRole"],
  currentPrompt: string,
  failingTraces: readonly TraceRecord[],
  suite: FrozenSuite | undefined,
  baseline: GateBaseline | undefined,
): string {
  const base = buildReflectionPrompt(role, currentPrompt, failingTraces);
  if (!suite || !baseline?.fixtures) return base;
  const failed = new Set(baseline.fixtures.filter((f) => !f.passed).map((f) => f.id));
  const lines = splitSuite(suite)
    .public.filter((f) => failed.has(f.id))
    .slice(0, 20)
    .map((f, i) => `Fixture ${i + 1} (${f.id}): ${f.prompt}`);
  if (lines.length === 0) return base;
  const section = ["", "Public eval fixtures the current prompt fails (a held-out private set is scored too, and is not shown):", ...lines, ""].join("\n");
  const at = base.lastIndexOf(RESPOND_MARKER);
  return at === -1 ? `${base}\n${section}` : `${base.slice(0, at)}${section}${base.slice(at)}`;
}
