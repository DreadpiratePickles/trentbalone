/**
 * [W3] Retrieval golden capture — the run bus in, a quarantined retrieval golden out.
 *
 * The fleet-memory hook emits a `recall` note when a seat calls `brain_read` on a chunk id its
 * recall had ranked (`fleet-memory/recall-note.ts`); the orchestrator carries it as a `step_note`.
 * This hook sits beside the failure capture on the same bus and turns each such note into
 * `{ query, expected: [read_id], source: "captured" }` under `<profile>/goldens/retrieval/`.
 *
 * It writes a QUARANTINED golden and nothing else: the human promotes it, exactly as with a
 * failure golden, so a seat's reading habits can propose an exam and never set one. The id is
 * content-addressed, so the same read in ten runs is one file and a decision already taken on it
 * is never reopened.
 */

import { parseRecallNote } from "../fleet-memory/recall-note.js";
import type { OrcEvent, TraceSink } from "../orchestrator/types.js";
import { addRetrievalGolden, listRetrievalGoldens, type RetrievalGolden } from "./golden-store.js";
import { nowIso } from "./ledger.js";
import type { BusHook } from "./trace-writer.js";

export interface RetrievalCaptureOptions {
  /** `retrievalGoldensDir(profileDir)`: always explicit, never derived from a runtime setting. */
  readonly dir: string;
  readonly now?: () => string;
  readonly onError?: (message: string) => void;
}

export interface RetrievalCapture extends BusHook {
  list(): Promise<RetrievalGolden[]>;
}

export function createRetrievalCapture(options: RetrievalCaptureOptions): RetrievalCapture {
  const now = options.now ?? nowIso;
  const pending = new Set<Promise<void>>();

  const sink: TraceSink = (event: OrcEvent) => {
    if (event.kind !== "step_note") return;
    const note = parseRecallNote(event.detail);
    if (note === undefined || note.query.trim() === "" || note.read_id.trim() === "") return;
    const task = addRetrievalGolden(options.dir, { query: note.query, expected_chunk_ids: [note.read_id], source: "captured", runId: event.runId }, now())
      .then(() => undefined)
      .catch((error: unknown) => {
        options.onError?.(`retrieval golden capture failed for run ${event.runId}: ${error instanceof Error ? error.message : String(error)}`);
      });
    pending.add(task);
    void task.finally(() => pending.delete(task));
  };

  return {
    sink,
    async flush() {
      while (pending.size > 0) await Promise.all([...pending]);
    },
    list: () => listRetrievalGoldens(options.dir),
  };
}
