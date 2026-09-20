/**
 * [W3] recall@k over a retrieval golden set, with the shipped ranker and with one patched through
 * the seam. Ids in, ids out, a number: no model is called and a fake `EmbedFn` stands in for the
 * configured one, so the result is the same on every machine.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createBrain, type Brain, type BrainExec } from "./brain.js";
import type { EmbedFn } from "./lexical.js";
import { brainRanker, evaluateRetrieval, DEFAULT_RECALL_K, RETRIEVAL_EVAL_SEAT, type RankedChunk } from "./retrieval-eval.js";
import { RETRIEVAL_FIXTURE_QUERIES, importRetrievalFixture } from "./retrieval-fixture.js";

let profileDir: string;
let sourceDir: string;
const noGit: BrainExec = () => ({ code: 127, stdout: "", stderr: "git: command not found" });

beforeEach(() => {
  profileDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "trent-retrieval-eval-")));
  sourceDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "trent-retrieval-eval-src-")));
});

afterEach(() => {
  fs.rmSync(profileDir, { recursive: true, force: true });
  fs.rmSync(sourceDir, { recursive: true, force: true });
});

async function fixtureBrain(): Promise<Brain> {
  const brain = createBrain({ profileDir, exec: noGit });
  brain.ensure();
  await importRetrievalFixture(brain, sourceDir);
  return brain;
}

/** A deterministic stand-in for a provider: a bag-of-characters vector, unit length, never the network. */
const fakeEmbed: EmbedFn = async (texts) =>
  texts.map((text) => {
    const v = new Array<number>(64).fill(0);
    for (const ch of text.toLowerCase()) v[ch.charCodeAt(0) % 64] += 1;
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
    return v.map((x) => x / norm);
  });

describe("[W3] evaluateRetrieval", () => {
  it("scores the audit's five queries recall@8 = 1.0 with the shipped ranker, per query hit and rank", async () => {
    const brain = await fixtureBrain();
    const result = await evaluateRetrieval(brain, RETRIEVAL_FIXTURE_QUERIES);
    expect(result.k).toBe(DEFAULT_RECALL_K);
    expect(result.queries).toBe(5);
    expect(result.hits).toBe(5);
    expect(result.recallAtK).toBe(1);
    for (const q of result.perQuery) {
      expect(q.hit, q.query).toBe(true);
      expect(q.rank, q.query).toBe(1);
      expect(q.ranked.length).toBeLessThanOrEqual(DEFAULT_RECALL_K);
      expect(q.ranked[0]).toBe(q.expected[0]);
    }
  });

  it("is the same number twice, and the same with a fake embedder in the blend", async () => {
    const brain = await fixtureBrain();
    const once = await evaluateRetrieval(brain, RETRIEVAL_FIXTURE_QUERIES);
    const twice = await evaluateRetrieval(brain, RETRIEVAL_FIXTURE_QUERIES);
    expect(twice).toEqual(once);
    const blended = await evaluateRetrieval(brain, RETRIEVAL_FIXTURE_QUERIES, { embed: fakeEmbed });
    expect(blended.recallAtK).toBe(1);
  });

  it("a ranker patched to return the reverse order loses the lease fact from the top 8", async () => {
    const brain = await fixtureBrain();
    const shipped = brainRanker({ brain });
    const reversed = async (query: string, seat: string): Promise<readonly RankedChunk[]> => [...(await shipped(query, seat))].reverse();
    const result = await evaluateRetrieval(brain, RETRIEVAL_FIXTURE_QUERIES, { rank: reversed });
    expect(result.recallAtK).toBeLessThan(0.9);
    const lease = result.perQuery.find((q) => q.id === "rgold_fixture_lease")!;
    expect(lease.hit).toBe(false);
    expect(lease.rank).toBeNull();
    expect(lease.ranked).not.toContain("lease#7");
  });

  it("counts a miss for a query nothing answers, and a hit by document slug and page", async () => {
    const brain = await fixtureBrain();
    const result = await evaluateRetrieval(brain, [
      { id: "g_miss", query: "book a flight to Lisbon next Tuesday", expected_chunk_ids: ["lease#7"] },
      { id: "g_doc", query: "how many days notice to end the office lease", expected_chunk_ids: [], expected_doc: { slug: "lease" } },
      { id: "g_long", query: "how many days notice to end the office lease", expected_chunk_ids: ["docs/lease.md#7"] },
    ]);
    expect(result.perQuery.map((q) => q.hit)).toEqual([false, true, true]);
    expect(result.recallAtK).toBeCloseTo(2 / 3, 6);
  });

  it("ranks for the shared view unless the golden names a seat, and k bounds what counts as found", async () => {
    const brain = await fixtureBrain();
    brain.writeSeatNote({ seat: "operations", text: "the office lease notice period was renegotiated to sixty days in the operations review", writer: "operations" });
    const seen: string[] = [];
    const spy = async (query: string, seat: string): Promise<readonly RankedChunk[]> => {
      seen.push(seat);
      return brainRanker({ brain })(query, seat);
    };
    const query = "what did the operations review renegotiate the notice period to";
    const shared = await evaluateRetrieval(brain, [{ id: "g", query, expected_chunk_ids: ["seats/operations/notes.md#1"] }], { rank: spy });
    const own = await evaluateRetrieval(brain, [{ id: "g", query, expected_chunk_ids: ["seats/operations/notes.md#1"], seat: "operations" }], { rank: spy });
    expect(seen).toEqual([RETRIEVAL_EVAL_SEAT, "operations"]);
    expect(shared.hits).toBe(0);
    expect(own.hits).toBe(1);

    const one = await evaluateRetrieval(brain, [{ id: "g", query: "how many days notice to end the office lease", expected_chunk_ids: ["lease#1"] }], { k: 1 });
    expect(one.hits).toBe(0);
    expect(one.perQuery[0]!.ranked).toHaveLength(1);
    expect(await evaluateRetrieval(brain, [])).toMatchObject({ queries: 0, hits: 0, recallAtK: 0 });
  });
});
