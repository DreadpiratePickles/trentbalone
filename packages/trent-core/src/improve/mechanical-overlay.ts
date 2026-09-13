/**
 * Mechanical-grader overlay (task I.6; CS329A L3 @61:42, L2 @13:12).
 *
 * The app's two real suites are 100 percent rubric, the one verifier class the course measured
 * as worse than majority voting, and `apps/web` is read-only. So the wrapper keeps its own
 * `<overlayRoot>/<skill>/evals/mechanical.json` and merges its `contains`, `required_tools`,
 * `forbidden_tools` and `state_check` graders onto the app's fixtures by eval id. Mechanical
 * graders run first in the gate and short-circuit it, so a missed term costs the executor calls
 * only, never a judge call. The merged suite's version folds the overlay in, so a baseline
 * measured without it is never reused with it. An overlay may also name the eval ids held
 * PRIVATE (task I.16): scored by the gate, never shown to the reflection; without it the split is
 * the deterministic hash in `suite-split.ts`.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { FrozenFixture, FrozenGrader, FrozenSuite } from "./suites.js";

/** Shape of `evals/mechanical.json`: one entry per app eval id, mechanical fields only. */
export interface MechanicalOverlayJson {
  skill_name: string;
  /** Eval ids held out of the GEPA reflection (task I.16). Overrides the hash split for the suite. */
  private?: Array<number | string>;
  evals: Array<{
    id: number | string;
    contains?: string[];
    required_tools?: string[];
    forbidden_tools?: string[];
    state_check?: Record<string, unknown>;
  }>;
}

/** Where the wrapper's bundled overlays live: `<this dir>/overlays/<skill>/evals/mechanical.json`. */
export const BUNDLED_MECHANICAL_OVERLAYS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "overlays");

export function mechanicalOverlayPath(overlayRoot: string, skill: string): string {
  return path.join(overlayRoot, skill, "evals", "mechanical.json");
}

/** Reads one overlay; undefined when absent or malformed (a grader is never guessed). */
export function loadMechanicalOverlay(file: string): MechanicalOverlayJson | undefined {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<MechanicalOverlayJson>;
    if (typeof parsed.skill_name !== "string" || !Array.isArray(parsed.evals)) return undefined;
    return parsed as MechanicalOverlayJson;
  } catch {
    return undefined;
  }
}

function gradersOf(entry: MechanicalOverlayJson["evals"][number]): FrozenGrader[] {
  const graders: FrozenGrader[] = [];
  if (entry.contains?.length) graders.push({ type: "contains", weight: 1, values: [...entry.contains] });
  if (entry.required_tools?.length || entry.forbidden_tools?.length) {
    graders.push({ type: "tool_call", weight: 1, required: entry.required_tools ?? [], forbidden: entry.forbidden_tools ?? [] });
  }
  if (entry.state_check && Object.keys(entry.state_check).length > 0) graders.push({ type: "state_check", weight: 1, expect: { ...entry.state_check } });
  return graders;
}

/**
 * Merges the overlay onto the suite: mechanical graders go AHEAD of the fixture's own graders,
 * keyed by `<skill>:<id>`; entries naming an id the suite lacks are ignored. Returns the same
 * suite object when nothing applied, so the version only moves when a grader landed.
 */
export function applyMechanicalOverlay(suite: FrozenSuite, overlay: MechanicalOverlayJson): FrozenSuite {
  const byId = new Map<string, FrozenGrader[]>(overlay.evals.map((entry) => [`${overlay.skill_name}:${entry.id}`, gradersOf(entry)]));
  const privateIds = new Set((overlay.private ?? []).map((id) => `${overlay.skill_name}:${id}`));
  let applied = 0;
  const fixtures: FrozenFixture[] = suite.fixtures.map((fixture) => {
    const extra = byId.get(fixture.id) ?? [];
    // An overlay that names any private id decides the whole suite's split: the rest are public.
    const visibility = privateIds.size === 0 ? {} : { private: privateIds.has(fixture.id) };
    const changed = extra.length > 0 || (privateIds.size > 0 && fixture.private !== privateIds.has(fixture.id));
    if (!changed) return fixture;
    applied += 1;
    return { ...fixture, graders: [...extra, ...fixture.graders], ...visibility };
  });
  if (applied === 0) return suite;
  const version = createHash("sha256")
    .update(`${suite.version}|overlay:${JSON.stringify(overlay.evals)}|private:${JSON.stringify([...privateIds].sort())}`)
    .digest("hex")
    .slice(0, 16);
  return { ...suite, version, fixtures };
}
