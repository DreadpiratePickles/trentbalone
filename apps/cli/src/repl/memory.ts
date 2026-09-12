/**
 * The durable index of this workspace's runs.
 *
 * Same reasoning as the approval index in approvals.ts: `StorePort` exposes `getRun` but
 * no `listRuns`, so after a restart there is no way to enumerate what this company has
 * done. The REPL therefore writes one `JobRun` of type `trent_run` per run, whose
 * `summary` is the run id, and reads company memory back through it. The run rows
 * themselves stay the source of truth.
 */

import type { ReplStore, RunRow, StepRow } from "./types.js";

export const RUN_INDEX_TYPE = "trent_run";

/** Indexes a run so `/wiki` can find it again in a later process. */
export async function rememberRun(store: ReplStore, companyId: string, runId: string): Promise<void> {
  await store.createJobRun({ type: RUN_INDEX_TYPE, trigger: "cli", companyId, summary: runId });
}

export interface RememberedRun {
  run: RunRow;
  steps: StepRow[];
}

/** Every indexed run this company has, newest first. */
export async function listRememberedRuns(
  store: ReplStore,
  companyId: string,
  limit = 100,
): Promise<RememberedRun[]> {
  const index = await store.listJobRuns(companyId, limit);
  const seen = new Set<string>();
  const runs: RememberedRun[] = [];
  for (const job of index) {
    if (job.type !== RUN_INDEX_TYPE || job.summary === "" || seen.has(job.summary)) continue;
    seen.add(job.summary);
    const run = await store.getRun(job.summary);
    if (run === null) continue;
    runs.push({ run, steps: await store.listSteps(run.id) });
  }
  return runs.sort((a, b) => b.run.startedAt.getTime() - a.run.startedAt.getTime());
}

/** Case-insensitive search over objectives, summaries and step outputs. */
export function searchRuns(runs: readonly RememberedRun[], query: string): RememberedRun[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return [...runs];
  return runs.filter(({ run, steps }) =>
    [run.objective, run.summary ?? "", ...steps.map((s) => `${s.title} ${s.output ?? ""}`)]
      .join(" ")
      .toLowerCase()
      .includes(needle),
  );
}
