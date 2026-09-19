/**
 * [D1] a promoted golden IS a fixture (plan decision 4: suites grow from failures on real runs,
 * never from an agent or a founder authoring an exam for themselves).
 *
 * A capture holds the sanitised objective, why the run was captured, and the trajectory
 * assertions that failed (`trajectory_<assertionId>`, `apps/web/lib/orchestration-eval-trajectory.ts`).
 * That is exactly enough for a regression fixture:
 *
 *   prompt      the sanitised objective, re-run under the candidate
 *   state_check the captured failure tags must not come back (`REPRODUCED_TAGS_STATE_KEY`)
 *   contains /
 *   tool_call   any mechanical assertion the capture already carries
 *   llm_rubric  one line per reviewer assertion, plus one carrying the captured reason to the
 *               judge — which is what a single completion can be graded on at all
 *
 * The failure-tag check is only as strong as the runner's observation, and that is deliberate:
 * `goldenActuals` intersects the tags the runner REPORTS (`state.failureTags`, which an
 * orchestrator-backed runner can fill and a one-completion runner cannot) with the tags the
 * capture holds. A runner that observed no trajectory reports no reproduced tag, and the rubric
 * carries the fixture. Absence of the check is never reported as a pass of it: without the
 * wrapper the grader has no state to read and the fixture fails deterministically.
 */

import { createHash } from "node:crypto";

import type { ActualsOutput, ActualsRunner } from "./gate-types.js";
import { promotedGoldens, reviewOf, type StoredGolden } from "./golden-store.js";
import type { FrozenFixture, FrozenGrader, FrozenSuite } from "./suites.js";

/** Fixture ids from goldens are namespaced, so a suite's provenance is readable in a verdict. */
export const GOLDEN_FIXTURE_PREFIX = "golden:";

/** The state key the failure-tag grader reads: the captured tags the re-run brought back. */
export const REPRODUCED_TAGS_STATE_KEY = "reproducedFailureTags";

export function goldenFixtureId(golden: StoredGolden): string {
  return `${GOLDEN_FIXTURE_PREFIX}${golden.id}`;
}

/** The judge's line for a golden: the objective it must actually complete, and the failure it must not repeat. */
export function goldenRubric(golden: StoredGolden): string {
  const tags = [...(golden.trajectoryFailureTags ?? [])];
  const tail = tags.length === 0 ? "" : ` The captured run failed these trajectory assertions: ${tags.join(", ")}.`;
  return `The output completes the captured objective and does not repeat the failure it was captured for: ${golden.reason}.${tail}`;
}

export function goldenFixture(golden: StoredGolden): FrozenFixture {
  const graders: FrozenGrader[] = [];
  if (golden.contains?.length) graders.push({ type: "contains", weight: 1, values: [...golden.contains] });
  if (golden.required_tools?.length || golden.forbidden_tools?.length) {
    graders.push({ type: "tool_call", weight: 1, required: [...(golden.required_tools ?? [])], forbidden: [...(golden.forbidden_tools ?? [])] });
  }
  if ((golden.trajectoryFailureTags ?? []).length > 0) {
    graders.push({ type: "state_check", weight: 1, expect: { [REPRODUCED_TAGS_STATE_KEY]: [] } });
  }
  for (const assertion of golden.assertions ?? []) graders.push({ type: "llm_rubric", weight: 1, rubric: assertion });
  graders.push({ type: "llm_rubric", weight: 1, rubric: goldenRubric(golden) });
  return { id: goldenFixtureId(golden), prompt: golden.objective, graders };
}

/**
 * The promoted goldens of one agent as a suite. Quarantined and rejected goldens are dropped
 * here, not filtered by the caller, so there is one place a golden can enter a gate.
 */
export function suiteFromGoldens(agentId: string, goldens: readonly StoredGolden[]): FrozenSuite | undefined {
  const promoted = promotedGoldens(goldens);
  if (promoted.length === 0) return undefined;
  const version = createHash("sha256")
    .update(promoted.map((g) => `${g.id}@${g.objective}@${g.reason}@${(g.trajectoryFailureTags ?? []).join(",")}`).join("|"))
    .digest("hex")
    .slice(0, 16);
  return { id: `${GOLDEN_FIXTURE_PREFIX}${agentId}`, version, fixtures: promoted.map(goldenFixture) };
}

/**
 * Which seats a golden belongs to. A reviewer's explicit list wins; otherwise the seats that
 * actually ran a step in the captured run, which the trace store already knows per run id. A
 * golden from a run with no traces belongs to no seat and cannot gate one.
 */
export function goldenSeats(golden: StoredGolden, rolesByRun: ReadonlyMap<string, readonly string[]>): readonly string[] {
  if (golden.seats?.length) return [...golden.seats];
  return [...(rolesByRun.get(golden.runId) ?? [])];
}

/** Every golden, indexed by the agent ids that may be gated on it. */
export function goldensByAgent(
  goldens: readonly StoredGolden[],
  rolesByRun: ReadonlyMap<string, readonly string[]>,
): Map<string, StoredGolden[]> {
  const index = new Map<string, StoredGolden[]>();
  for (const golden of goldens) {
    for (const seat of goldenSeats(golden, rolesByRun)) {
      const bucket = index.get(seat) ?? [];
      bucket.push(golden);
      index.set(seat, bucket);
    }
  }
  return index;
}

function observedTags(state: Record<string, unknown> | undefined): string[] {
  const raw = state?.failureTags;
  return Array.isArray(raw) ? raw.filter((tag): tag is string => typeof tag === "string") : [];
}

/**
 * Wraps a runner so a golden fixture's `state_check` has something to read: the captured tags
 * this run brought back. Everything else the underlying runner reported is passed through.
 */
export function goldenActuals(underlying: ActualsRunner, goldens: readonly StoredGolden[]): ActualsRunner {
  const tags = new Map(goldens.map((golden) => [goldenFixtureId(golden), [...(golden.trajectoryFailureTags ?? [])]] as const));
  return async (input) => {
    const result = await underlying(input);
    const captured = tags.get(input.fixtureId);
    if (captured === undefined) return result;
    const reproduced = observedTags(result.state).filter((tag) => captured.includes(tag));
    const out: ActualsOutput = { ...result, state: { ...(result.state ?? {}), [REPRODUCED_TAGS_STATE_KEY]: reproduced } };
    return out;
  };
}

/** Counts a `no_suite` refusal has to name, so a human reads what is missing, not that it is missing. */
export interface GoldenCounts {
  readonly promoted: number;
  readonly quarantined: number;
}

export function goldenCounts(goldens: readonly StoredGolden[]): GoldenCounts {
  return {
    promoted: goldens.filter((g) => reviewOf(g) === "promoted").length,
    quarantined: goldens.filter((g) => reviewOf(g) === "quarantined").length,
  };
}
