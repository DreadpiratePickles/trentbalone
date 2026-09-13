/**
 * Where shared context comes from. One port, two implementations: the in-memory one for tests
 * and the app-backed one (`app-source.ts`) that reads the company's own SQLite store through the
 * read-only web modules. Everything a seat can recall or search is reachable from here:
 *   - completed runs with their steps' outputs and the consolidated summary (every agent's,
 *     delegated children included);
 *   - live skills, the org tier included (`ImproveStorePort`, keyed by agentId);
 *   - the company playbook (folded bullets the reflection loop maintains).
 */

import type { ImproveStorePort } from "../store/StorePort.js";

export interface FleetStep {
  readonly id: string;
  readonly runId: string;
  /** The seat the step ran under; `[delegated]` in the title marks a child step. */
  readonly agentRole: string;
  readonly title: string;
  readonly status: string;
  readonly output: string | null;
}

export interface FleetRun {
  readonly id: string;
  readonly companyId: string;
  readonly objective: string;
  readonly status: string;
  /** The consolidated brief, when the run got that far. */
  readonly summary: string | null;
  readonly completedAt: string | null;
  readonly steps: readonly FleetStep[];
}

export interface FleetPlaybookEntry {
  readonly topic: string;
  readonly text: string;
}

export interface FleetMemorySource {
  /** Runs for the company, newest first. */
  listRuns(companyId: string): Promise<readonly FleetRun[]>;
  /** The improve loop's tables, for skills. Absent when no durable store is attached. */
  readonly improve?: ImproveStorePort;
  listPlaybook?(companyId: string): Promise<readonly FleetPlaybookEntry[]>;
}

export function isDelegatedStep(step: Pick<FleetStep, "title">): boolean {
  return /^\[delegated\]/i.test(step.title.trim());
}

export function isDelegatedObjective(objective: string): boolean {
  return /^\[delegated\]/i.test(objective.trim());
}

/** Test double and offline fallback. Runs are returned newest-first by insertion. */
export class InMemoryFleetSource implements FleetMemorySource {
  readonly #runs: FleetRun[] = [];
  readonly #playbook = new Map<string, FleetPlaybookEntry[]>();
  readonly improve: ImproveStorePort | undefined;

  constructor(options: { improve?: ImproveStorePort } = {}) {
    this.improve = options.improve;
  }

  addRun(run: FleetRun): void {
    this.#runs.unshift(run);
  }

  addPlaybook(companyId: string, entry: FleetPlaybookEntry): void {
    const list = this.#playbook.get(companyId) ?? [];
    list.push(entry);
    this.#playbook.set(companyId, list);
  }

  async listRuns(companyId: string): Promise<readonly FleetRun[]> {
    return this.#runs.filter((r) => r.companyId === companyId);
  }

  async listPlaybook(companyId: string): Promise<readonly FleetPlaybookEntry[]> {
    return this.#playbook.get(companyId) ?? [];
  }
}
