/**
 * [P2-6] The docs-corpus retrieval golden suite, offline: Trent's own `docs/*.md` (a fixed
 * snapshot), imported through the brain importer, forty questions, and the SHIPPED ranker measured
 * in its three modes — lexical with no key, and the hybrid and the dense half alone replayed from
 * the recorded `gemini-embedding-001` cosines (`recorded-embedder.ts`), so CI needs no key and makes
 * no call. The numbers asserted below are the ones `docs-corpus.live.test.ts` measured live, and
 * the replay is proven equal to that live run question for question there. They are floors: a
 * change that loses a question fails here, one that gains a question should raise the floor.
 *
 * The first block guards the exam itself (a fixed snapshot, phrases that name one page, categories
 * that mean what they say, the text the ranker embeds). The second enforces the number, through the
 * retrieval gate's own grader: at its default floor (0.9) the gate reports a breach on real
 * documents, and the hybrid a seat's prompt gets must hold the measured floor below it.
 * See 01_discovery/output/retrieval-measurement-2026-09-25.md.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createBrain, type Brain, type BrainExec } from "../fleet-memory/brain.js";
import { recallFromBrain } from "../fleet-memory/brain-index.js";
import { tokenize, type EmbedFn } from "../fleet-memory/lexical.js";
import { RETRIEVAL_EVAL_SEAT } from "../fleet-memory/retrieval-eval.js";
import {
  chunkScorableText,
  corpusDocPath,
  importDocsCorpus,
  loadDocsCorpus,
  normalisePhrase,
  resolveDocsCorpusGoldens,
  type DocsCorpus,
  type ResolvedDocsCorpus,
} from "./docs-corpus.js";
import { RECORDED_COSINES_FILE, readRecordedCosines, recordedEmbedFn, type RecordedEmbedFn } from "./recorded-embedder.js";
import { DEFAULT_RETRIEVAL_MIN_RECALL, gradeRetrievalRecall, retrievalBreached } from "./retrieval-gate.js";
import { measureMode, rankerFor, type ModeReport } from "./retrieval-metrics.js";

const FIXTURE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "docs-corpus");
/**
 * The floor this suite enforces on the shipped hybrid: 22 of 35, measured 2026-09-25 after the
 * brain-recall gate fix (0.400 before it). Under `retrieval.min_recall` (0.9) on purpose — that gap
 * is the measurement decision E was waiting for; raise this number as retrieval improves.
 */
const HYBRID_MIN_RECALL = 22 / 35;
const noGit: BrainExec = () => ({ code: 127, stdout: "", stderr: "git: command not found" });

let work: string;
let brain: Brain;
let corpus: DocsCorpus;
let resolved: ResolvedDocsCorpus;

beforeAll(async () => {
  work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "trent-docs-corpus-")));
  fs.mkdirSync(path.join(work, "src"));
  brain = createBrain({ profileDir: path.join(work, "profile"), exec: noGit });
  brain.ensure();
  corpus = loadDocsCorpus(FIXTURE_DIR);
  await importDocsCorpus(brain, corpus, path.join(work, "src"));
  resolved = resolveDocsCorpusGoldens(brain, corpus);
}, 120_000);

afterAll(() => {
  fs.rmSync(work, { recursive: true, force: true });
});

/** Every token the ranker could match between a question and the chunks that answer it. */
function sharedTokens(query: string, chunkIds: readonly string[]): string[] {
  const wanted = new Set(tokenize(query));
  const texts = resolved.entries.filter((e) => chunkIds.includes(e.id)).map(chunkScorableText);
  return [...new Set(texts.flatMap((t) => tokenize(t)).filter((t) => wanted.has(t)))];
}

describe("[P2-6] the docs corpus is a fixed exam over real documents", () => {
  it("is the 28-file docs snapshot, byte-verified, with 40 questions: 12 exact-term, 12 paraphrased, 11 multi-hop, 5 no-answer", () => {
    expect(corpus.snapshotOf).toBe("docs/*.md");
    expect(corpus.files).toHaveLength(28);
    expect(corpus.files.map((f) => f.name)).toContain("configuration.md");
    const count = (category: string): number => corpus.questions.filter((q) => q.category === category).length;
    expect([count("exact_term"), count("paraphrased"), count("multi_hop"), count("no_answer")]).toEqual([12, 12, 11, 5]);
  });

  it("imports whole through the brain importer, and every phrase resolves to chunks of its own page only", () => {
    expect(resolved.entries).toHaveLength(625);
    expect(new Set(resolved.entries.map((e) => e.path)).size).toBe(28);
    expect(resolved.answerable).toHaveLength(35);
    for (const golden of resolved.answerable) {
      expect(golden.expected_chunk_ids.length, golden.id).toBeGreaterThanOrEqual(1);
      const paths = new Set(resolved.entries.filter((e) => golden.expected_chunk_ids.includes(e.id)).map((e) => e.path));
      expect([...paths], golden.id).toEqual([corpusDocPath(golden.file)]);
    }
  });

  it("holds each category to its definition", () => {
    for (const q of corpus.questions) {
      if (q.category === "no_answer") {
        for (const term of q.absent) expect(resolved.entries.some((e) => normalisePhrase(e.text).includes(normalisePhrase(term))), `${q.id} ${term}`).toBe(false);
        continue;
      }
      const golden = resolved.answerable.find((g) => g.id === q.id)!;
      const shared = sharedTokens(q.query, golden.expected_chunk_ids);
      if (q.category === "exact_term") {
        expect(q.term, q.id).toBeDefined();
        expect(q.query.includes(q.term!), q.id).toBe(true);
        for (const id of golden.expected_chunk_ids) expect(resolved.entries.find((e) => e.id === id)!.text.includes(q.term!), `${q.id} ${id}`).toBe(true);
      }
      // A paraphrase shares NO token (by the shipped tokenizer) with anything the ranker reads of
      // its answer — path, title, heading or text — so TF-IDF cannot find it by construction.
      if (q.category === "paraphrased") expect(shared, q.id).toEqual([]);
      if (q.category === "multi_hop") expect(shared.length, `${q.id} ${shared.join(",")}`).toBeLessThanOrEqual(2);
    }
  });

  it("restates, byte for byte, the text the shipped ranker hands the embedder", async () => {
    const seen: string[][] = [];
    const spy: EmbedFn = async (texts) => {
      seen.push([...texts]);
      return texts.map(() => [1, 0]);
    };
    await recallFromBrain({ profileDir: brain.profileDir, brain, seat: RETRIEVAL_EVAL_SEAT, objective: "which seats carry the business toolset", embed: spy });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.slice(0, -1)).toEqual(resolved.entries.map(chunkScorableText));
    expect(seen[0]!.at(-1)).toBe("which seats carry the business toolset");
  });
});

describe("[P2-6] recall on real documents, enforced", () => {
  let replay: RecordedEmbedFn;
  let lexical: ModeReport;
  let embedding: ModeReport;
  let hybrid: ModeReport;

  beforeAll(async () => {
    replay = recordedEmbedFn(readRecordedCosines(path.join(FIXTURE_DIR, RECORDED_COSINES_FILE)));
    const measure = (mode: "lexical" | "embedding" | "hybrid"): Promise<ModeReport> =>
      measureMode({ mode, brain, rank: rankerFor(mode, brain, mode === "lexical" ? undefined : replay), answerable: resolved.answerable, noAnswer: resolved.noAnswer });
    lexical = await measure("lexical");
    embedding = await measure("embedding");
    hybrid = await measure("hybrid");
  }, 300_000);

  it("the recording covers every chunk and every question, so the hybrid measured is the hybrid and not its lexical fallback", () => {
    expect(replay.stats().missingQueries).toEqual([]);
    expect(replay.stats().missingChunks).toBe(0);
    expect(replay.stats().calls).toBeGreaterThanOrEqual(2 * corpus.questions.length);
  });

  it("the gate, run on real documents at its default floor, reports a measured breach: decision E's trigger has fired", async () => {
    const report = await gradeRetrievalRecall({ evaluate: async () => hybrid.evaluation });
    expect(report).toMatchObject({ measured: true, passed: false, minRecall: DEFAULT_RETRIEVAL_MIN_RECALL, queries: 35 });
    expect(retrievalBreached(report)).toBe(true);
  });

  it("the shipped hybrid holds the measured floor through the gate's own grader, and returns every answer its own top 8 held", async () => {
    const report = await gradeRetrievalRecall({ evaluate: async () => hybrid.evaluation, minRecall: HYBRID_MIN_RECALL });
    expect(report.passed, `recall@8 ${String(report.recallAtK)}; missed ${report.misses.map((m) => m.id).join(", ")}`).toBe(true);
    // The seven the failure analysis found ranked 1-8 by the blend and then dropped under
    // recallMinScore (0.12) although their cosine cleared the embedder's floor.
    const missed = new Set(report.misses.map((m) => m.id));
    for (const id of ["para-05", "para-07", "para-10", "para-12", "hop-03", "hop-04", "hop-09"]) expect(missed.has(id), id).toBe(false);
    expect(hybrid.byCategory.exact_term.hitsAt8).toBe(12);
    expect(hybrid.byCategory.paraphrased.hitsAt8).toBeGreaterThanOrEqual(5);
    expect(hybrid.byCategory.multi_hop.hitsAt8).toBeGreaterThanOrEqual(5);
    expect(hybrid.noAnswer.abstained).toBeGreaterThanOrEqual(2);
  });

  it("the blend is never worse than either of its halves", () => {
    expect(embedding.overall.queries).toBe(35);
    expect(hybrid.overall.hitsAt8).toBeGreaterThanOrEqual(Math.max(lexical.overall.hitsAt8, embedding.overall.hitsAt8));
  });

  it("the lexical ranker an offline sweep measures keeps its measured floor: every exact term, no paraphrase", () => {
    expect(lexical.byCategory.exact_term.recallAt8).toBe(1);
    expect(lexical.byCategory.paraphrased.recallAt8).toBe(0);
    expect(lexical.overall.hitsAt8).toBeGreaterThanOrEqual(12);
    expect(lexical.noAnswer.abstained).toBeGreaterThanOrEqual(2);
  });

  it("the dense half alone keeps its measured floor", () => {
    expect(embedding.overall.hitsAt8).toBeGreaterThanOrEqual(21);
    expect(embedding.byCategory.paraphrased.hitsAt8).toBeGreaterThanOrEqual(6);
  });
});
