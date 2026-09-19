/**
 * [D1] suite lookup by SEAT id — the reason no seat could ever promote.
 *
 * The CLI resolved every suite through `getCatalogAgent(agentId)?.skills`
 * (`apps/cli/src/commands/improve.ts`), and `AGENT_CATALOG` holds 164 specialist ids and not one
 * seat id, so `ceo`, `finance`, `sales` and the rest all resolved `undefined` and the gate
 * answered `no_suite` forever (audit 4.3, shortfall 2).
 *
 * A seat's suite is now assembled from two sources:
 *   goldens  the seat's PROMOTED failure goldens, one fixture each (`golden-suite.ts`) — the only
 *            growth path decision 4 allows;
 *   skills   the seat's own skills, which live in the application's `SLOT_ENVIRONMENTS`, for the
 *            few that ship `evals/evals.json` and for the wrapper's mechanical overlays.
 * A catalog specialist keeps the path it always had: its catalog skills.
 *
 * A seat with neither is still refused — but the refusal now names the seat and what it would
 * take to gate it, because "no_suite" on nine seats told a human nothing.
 */

import path from "node:path";

import { goldenCounts, suiteFromGoldens, type GoldenCounts } from "./golden-suite.js";
import type { StoredGolden } from "./golden-store.js";
import { applyMechanicalOverlay, loadMechanicalOverlay, mechanicalOverlayPath } from "./mechanical-overlay.js";
import { loadSkillSuite, mergeSuites, type FrozenSuite, type SuiteProvider } from "./suites.js";
import { CORE_SEATS } from "./trace-writer.js";

/** The application's per-seat skills. Loaded lazily: a status listing must not pay for the catalog. */
let slotSkills: Promise<Readonly<Record<string, readonly string[]>>> | undefined;

export async function seatSkills(role: string): Promise<readonly string[]> {
  slotSkills ??= import("@/lib/agent-catalog").then(({ SLOT_ENVIRONMENTS }) =>
    Object.fromEntries(Object.entries(SLOT_ENVIRONMENTS).map(([id, env]) => [id, [...(env.skills ?? [])]])),
  );
  return (await slotSkills)[role] ?? [];
}

/** The catalog path, for an installed specialist. Lazy for the same reason. */
async function catalogSkills(agentId: string): Promise<readonly string[]> {
  const { getCatalogAgent } = await import("../agents/index.js");
  return getCatalogAgent(agentId)?.skills ?? [];
}

export interface SeatSuiteOptions {
  /** Root of the bundled skills tree (`<root>/<skill>/evals/evals.json`). */
  readonly skillsRoot: string;
  /** Root of the wrapper's `<skill>/evals/mechanical.json` overlays. */
  readonly overlayRoot?: string;
  /** Seat ids. Defaults to the execution roster (`CORE_SEATS`). */
  readonly seats?: readonly string[];
  /** Every golden that may gate this agent, in any review state. */
  readonly goldensFor: (agentId: string) => Promise<readonly StoredGolden[]> | readonly StoredGolden[];
  /** Skills for an agent. Defaults to the seat map for a seat and the catalog for anything else. */
  readonly skillsFor?: (agentId: string) => Promise<readonly string[]> | readonly string[];
}

export interface SeatSuites {
  readonly suiteFor: SuiteProvider;
  /** The `no_suite` refusal, naming the seat and its golden counts. */
  readonly noSuiteReason: (agentId: string) => Promise<string>;
  readonly countsFor: (agentId: string) => Promise<GoldenCounts>;
  readonly isSeat: (agentId: string) => boolean;
}

function skillSuites(skillsRoot: string, overlayRoot: string | undefined, skills: readonly string[]): FrozenSuite[] {
  const suites: FrozenSuite[] = [];
  for (const skill of skills) {
    const suite = loadSkillSuite(path.join(skillsRoot, skill, "evals", "evals.json"));
    if (!suite) continue;
    const overlay = overlayRoot === undefined ? undefined : loadMechanicalOverlay(mechanicalOverlayPath(overlayRoot, skill));
    suites.push(overlay ? applyMechanicalOverlay(suite, overlay) : suite);
  }
  return suites;
}

export function createSeatSuites(options: SeatSuiteOptions): SeatSuites {
  const seats = new Set(options.seats ?? CORE_SEATS);
  const isSeat = (agentId: string): boolean => seats.has(agentId);
  const skillsFor = options.skillsFor ?? ((agentId: string) => (isSeat(agentId) ? seatSkills(agentId) : catalogSkills(agentId)));

  const countsFor = async (agentId: string): Promise<GoldenCounts> => goldenCounts(await options.goldensFor(agentId));

  const suiteFor: SuiteProvider = async (agentId) => {
    const goldens = await options.goldensFor(agentId);
    const fromGoldens = suiteFromGoldens(agentId, goldens);
    const suites = [...(fromGoldens ? [fromGoldens] : []), ...skillSuites(options.skillsRoot, options.overlayRoot, await skillsFor(agentId))];
    return mergeSuites(agentId, suites);
  };

  const noSuiteReason = async (agentId: string): Promise<string> => {
    const counts = await countsFor(agentId);
    const what = isSeat(agentId) ? `seat ${agentId}` : `agent ${agentId}`;
    return `no_suite: ${what} has ${counts.promoted} promoted and ${counts.quarantined} quarantined goldens and no skill suite; a seat is gateable once a captured golden is promoted (trent improve goldens promote <id>)`;
  };

  return { suiteFor, noSuiteReason, countsFor, isSeat };
}
