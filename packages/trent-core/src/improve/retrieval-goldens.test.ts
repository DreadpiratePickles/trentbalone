/**
 * [W3] Retrieval goldens: the store side, and the capture from a `recall` note on the run bus.
 *
 * A retrieval golden is `{ query, expected_chunk_ids[] }` with a source: a founder wrote it, or a
 * run produced it because a seat called `brain_read` on a chunk id its own recall had ranked.
 * Like a failure golden it starts quarantined, is promoted by a human, and lives under the frozen
 * `<profile>/goldens` tree, so the loop that is measured by it can never write it.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { encodeRecallNote } from "../fleet-memory/recall-note.js";
import type { OrcEvent } from "../orchestrator/types.js";
import {
  addRetrievalGolden,
  getRetrievalGolden,
  goldensDir,
  listRetrievalGoldens,
  promotedRetrievalGoldens,
  retrievalGoldenId,
  retrievalGoldensDir,
  reviewOf,
  setRetrievalGoldenStatus,
} from "./golden-store.js";
import { createRetrievalCapture } from "./retrieval-capture.js";
import { createFrozenSurface } from "./frozen-surface.js";
import { DEFAULT_MEMORY_BLOCKS } from "../tools/memory/blocks.js";

let profileDir: string;
const NOW = "2026-09-20T12:00:00.000Z";

beforeEach(() => {
  profileDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "trent-retrieval-goldens-")));
});

afterEach(() => {
  fs.rmSync(profileDir, { recursive: true, force: true });
});

describe("[W3] the retrieval golden kind", () => {
  it("lives under the goldens tree, so the frozen surface refuses the loop writing it", () => {
    const dir = retrievalGoldensDir(profileDir);
    expect(dir.startsWith(goldensDir(profileDir))).toBe(true);
    const surface = createFrozenSurface({ profileDir, blocks: DEFAULT_MEMORY_BLOCKS });
    expect(surface.violationFor({ path: path.join(dir, "retrieval-x.json") })?.frozenClass).toBe("golden");
  });

  it("a founder golden is added quarantined, listed, promoted and rejected by id", async () => {
    const dir = retrievalGoldensDir(profileDir);
    const added = await addRetrievalGolden(dir, { query: "what is the notice period on the office lease", expected_chunk_ids: ["lease#7"], source: "founder" }, NOW);
    expect(added.kind).toBe("retrieval");
    expect(added.source).toBe("founder");
    expect(reviewOf(added)).toBe("quarantined");
    expect(added.id).toBe(retrievalGoldenId("what is the notice period on the office lease", ["lease#7"]));

    const listed = await listRetrievalGoldens(dir);
    expect(listed.map((g) => g.id)).toEqual([added.id]);
    expect(promotedRetrievalGoldens(listed)).toEqual([]);

    const promoted = await setRetrievalGoldenStatus(dir, added.id, "promoted", NOW);
    expect(reviewOf(promoted)).toBe("promoted");
    expect(promoted.promotedAt).toBe(NOW);
    expect(promotedRetrievalGoldens(await listRetrievalGoldens(dir)).map((g) => g.id)).toEqual([added.id]);

    const rejected = await setRetrievalGoldenStatus(dir, added.id, "rejected", NOW);
    expect(reviewOf(rejected)).toBe("rejected");
    expect((await getRetrievalGolden(dir, added.id)).rejectedAt).toBe(NOW);
  });

  it("the same query and ids added twice is one golden, and the human's review survives the second add", async () => {
    const dir = retrievalGoldensDir(profileDir);
    const first = await addRetrievalGolden(dir, { query: "lease notice period", expected_chunk_ids: ["lease#7"], source: "founder" }, NOW);
    await setRetrievalGoldenStatus(dir, first.id, "promoted", NOW);
    const again = await addRetrievalGolden(dir, { query: "lease notice period", expected_chunk_ids: ["lease#7"], source: "captured", runId: "run_9" }, NOW);
    expect(again.id).toBe(first.id);
    expect(reviewOf(again)).toBe("promoted");
    expect(await listRetrievalGoldens(dir)).toHaveLength(1);
  });

  it("a file that is not a retrieval golden is ignored, and an unknown id is a usage error", async () => {
    const dir = retrievalGoldensDir(profileDir);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "stray.json"), JSON.stringify({ id: "x", objective: "not a retrieval golden", runId: "r" }), "utf8");
    expect(await listRetrievalGoldens(dir)).toEqual([]);
    await expect(getRetrievalGolden(dir, "rgold_missing")).rejects.toMatchObject({ code: expect.any(Number) });
  });
});

function note(runId: string, detail: string | undefined, kind: OrcEvent["kind"] = "step_note"): OrcEvent {
  return { kind, runId, at: NOW, ...(detail === undefined ? {} : { detail }) };
}

describe("[W3] a recall note on the bus becomes a quarantined retrieval golden", () => {
  it("captures {query, expected: [read_id]} from the note, quarantined and attributed to the run", async () => {
    const dir = retrievalGoldensDir(profileDir);
    const capture = createRetrievalCapture({ dir, now: () => NOW });
    capture.sink(note("run_42", encodeRecallNote({ query: "how long is the notice period", ranked_ids: ["lease#7", "lease#2", "handbook#3"], read_id: "lease#7" })));
    await capture.flush();

    const goldens = await listRetrievalGoldens(dir);
    expect(goldens).toHaveLength(1);
    expect(goldens[0]).toMatchObject({
      kind: "retrieval",
      query: "how long is the notice period",
      expected_chunk_ids: ["lease#7"],
      source: "captured",
      runId: "run_42",
      capturedAt: NOW,
    });
    expect(reviewOf(goldens[0]!)).toBe("quarantined");
  });

  it("ignores every other note and every other event kind", async () => {
    const dir = retrievalGoldensDir(profileDir);
    const capture = createRetrievalCapture({ dir, now: () => NOW });
    capture.sink(note("run_1", "context pressure on run run_1, seat ceo: the wrapper's injection is 90000 chars"));
    capture.sink(note("run_1", undefined));
    capture.sink(note("run_1", encodeRecallNote({ query: "q", ranked_ids: ["a#1"], read_id: "a#1" }), "step_end"));
    capture.sink(note("run_1", "recall {not json"));
    await capture.flush();
    expect(await listRetrievalGoldens(dir)).toEqual([]);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it("the same read in two runs is one golden", async () => {
    const dir = retrievalGoldensDir(profileDir);
    const capture = createRetrievalCapture({ dir, now: () => NOW });
    const detail = encodeRecallNote({ query: "notice period", ranked_ids: ["lease#7"], read_id: "lease#7" });
    capture.sink(note("run_1", detail));
    capture.sink(note("run_2", detail));
    await capture.flush();
    expect(await listRetrievalGoldens(dir)).toHaveLength(1);
  });
});
