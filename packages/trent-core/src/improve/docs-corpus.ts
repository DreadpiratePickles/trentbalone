/**
 * [P2-6] The docs corpus: a retrieval golden set over REAL documents — Trent's own `docs/*.md`,
 * snapshotted into `fixtures/docs-corpus/corpus.json` — and forty questions written against it.
 *
 * Why it exists: the reranker and the contextual-prefix proposals (upgrade-round design, decision E)
 * were deferred behind "recall@8 on the golden set below 0.9 after ingestion of real documents",
 * and the only golden set was five synthetic documents built so the shipped ranker scores 1.0
 * (`fleet-memory/retrieval-fixture.ts`). This is the measurement that decision was waiting for,
 * kept as a suite so the number is enforced from now on.
 *
 * What is frozen, and why it is a snapshot rather than a live read of `docs/`: other people edit
 * those files every day, and an exam that moves under the ranker is not an exam. The fixture is
 * under `improve/`, so the improve loop's frozen surface (class `gate_code`) already refuses a
 * draft that writes it.
 *
 * A question names its source file and a phrase that must appear in the retrieved chunk. The chunk
 * ids are not written down: they are RESOLVED from the phrase through the shipped importer and
 * chunker, so a chunker change renumbers nothing by hand and a phrase that stops resolving to
 * exactly its own file is an error, not a silent miss.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

import { EXIT, TrentError } from "../errors/index.js";
import type { Brain } from "../fleet-memory/brain.js";
import { loadBrainIndex, type BrainIndexEntry } from "../fleet-memory/brain-index.js";
import { docSlug, ingestDocuments, type IngestResult } from "../fleet-memory/ingest/index.js";
import type { RetrievalQuery } from "../fleet-memory/retrieval-eval.js";

export const DOCS_CORPUS_CATEGORIES = ["exact_term", "paraphrased", "multi_hop", "no_answer"] as const;
export type DocsCorpusCategory = (typeof DOCS_CORPUS_CATEGORIES)[number];
export type AnswerableCategory = Exclude<DocsCorpusCategory, "no_answer">;

export const DOCS_CORPUS_FILE = "corpus.json";
export const DOCS_CORPUS_QUESTIONS_FILE = "questions.json";

const CorpusFileSchema = z
  .object({
    name: z.string().regex(/^[A-Za-z0-9_.-]+\.md$/),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    text: z.string().min(1),
  })
  .strict();

const CorpusSchema = z
  .object({
    snapshot_of: z.string().min(1),
    snapshot_at: z.string().min(1),
    head: z.string().min(1),
    files: z.array(CorpusFileSchema).min(1),
  })
  .strict();

const QuestionId = z.string().regex(/^[a-z]+-[0-9]{2}$/);
const QueryText = z.string().trim().min(8);

const AnswerableSchema = z
  .object({
    id: QuestionId,
    category: z.enum(["exact_term", "paraphrased", "multi_hop"]),
    query: QueryText,
    /** The corpus file the answer is in, by the name it has in `docs/`. */
    file: z.string().regex(/\.md$/),
    /** Text that must appear in a retrieved chunk for the question to count as answered. */
    phrase: z.string().trim().min(6),
    /** exact_term only: the identifier the question names verbatim. */
    term: z.string().min(3).optional(),
  })
  .strict();

const NoAnswerSchema = z
  .object({
    id: QuestionId,
    category: z.literal("no_answer"),
    query: QueryText,
    /** Terms that must appear nowhere in the corpus, which is what makes "no answer" true. */
    absent: z.array(z.string().min(3)).min(1),
  })
  .strict();

const QuestionsSchema = z
  .object({
    about: z.string().min(1),
    questions: z.array(z.union([AnswerableSchema, NoAnswerSchema])).min(1),
  })
  .strict();

export type DocsCorpusFile = z.infer<typeof CorpusFileSchema>;
export type AnswerableQuestion = z.infer<typeof AnswerableSchema>;
export type NoAnswerQuestion = z.infer<typeof NoAnswerSchema>;
export type DocsCorpusQuestion = AnswerableQuestion | NoAnswerQuestion;

export interface DocsCorpus {
  readonly dir: string;
  readonly snapshotOf: string;
  readonly head: string;
  readonly files: readonly DocsCorpusFile[];
  readonly questions: readonly DocsCorpusQuestion[];
}

function fixtureError(message: string, target: string): TrentError {
  return new TrentError({ code: EXIT.CONFIG, operation: "improve.docs_corpus", message, target });
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  } catch (cause) {
    throw new TrentError({ code: EXIT.CONFIG, operation: "improve.docs_corpus", message: `cannot read ${file}`, target: file, cause });
  }
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Reads and validates the fixture: the schema, every file's sha256, unique names and ids. */
export function loadDocsCorpus(dir: string): DocsCorpus {
  const corpus = CorpusSchema.parse(readJson(path.join(dir, DOCS_CORPUS_FILE)));
  const questions = QuestionsSchema.parse(readJson(path.join(dir, DOCS_CORPUS_QUESTIONS_FILE))).questions;
  const names = new Set<string>();
  for (const file of corpus.files) {
    if (names.has(file.name)) throw fixtureError(`corpus file ${file.name} appears twice`, file.name);
    names.add(file.name);
    if (sha256Hex(file.text) !== file.sha256) throw fixtureError(`corpus file ${file.name} does not match its sha256`, file.name);
  }
  const ids = new Set<string>();
  for (const q of questions) {
    if (ids.has(q.id)) throw fixtureError(`question id ${q.id} appears twice`, q.id);
    ids.add(q.id);
    if (q.category !== "no_answer" && !names.has(q.file)) throw fixtureError(`question ${q.id} names ${q.file}, which is not in the corpus`, q.id);
  }
  return { dir, snapshotOf: corpus.snapshot_of, head: corpus.head, files: corpus.files, questions };
}

/**
 * Writes the snapshot under `sourceDir` by the names it had in `docs/` and imports it through
 * `ingestDocuments` — the call `trent brain import` makes — so the chunks measured are the chunks a
 * founder's import produces. A file that fails to import fails the corpus: a partial exam is not one.
 */
export async function importDocsCorpus(brain: Brain, corpus: DocsCorpus, sourceDir: string): Promise<IngestResult> {
  const paths = corpus.files.map((file) => {
    const target = path.join(sourceDir, file.name);
    fs.writeFileSync(target, file.text, "utf8");
    return target;
  });
  const result = await ingestDocuments({ brain, paths });
  if (result.failed > 0 || result.imported + result.updated + result.unchanged !== corpus.files.length) {
    const failed = result.files.filter((f) => f.status === "failed").map((f) => `${path.basename(f.source)}: ${f.reason ?? "failed"}`);
    throw fixtureError(`the docs corpus did not import whole (${failed.join("; ") || `${String(result.files.length)} of ${String(corpus.files.length)} files`})`, sourceDir);
  }
  return result;
}

/**
 * What the ranker scores of one chunk — the same string `brain-index.ts` builds (its `scorable`),
 * which is what the embedder is handed. Restated here because the recorded embeddings are keyed on
 * it; `docs-corpus.test.ts` spies on the shipped ranker's embed call and asserts the two agree, so
 * a change to the shipped string fails that test instead of silently missing every recording.
 */
export function chunkScorableText(entry: Pick<BrainIndexEntry, "path" | "title" | "heading" | "sheet" | "text">): string {
  return `${entry.path} ${entry.title} ${entry.heading ?? ""} ${entry.sheet ?? ""} ${entry.text}`;
}

/** Case- and whitespace-insensitive, so a phrase survives the chunker's line joins. */
export function normalisePhrase(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

/** The brain-relative doc path a corpus file imports to: `docs/<slug>.md`, by the importer's own slug. */
export function corpusDocPath(fileName: string): string {
  return `docs/${docSlug(fileName)}.md`;
}

export interface DocsCorpusGolden extends RetrievalQuery {
  readonly category: AnswerableCategory;
  readonly file: string;
}

export interface ResolvedDocsCorpus {
  readonly answerable: readonly DocsCorpusGolden[];
  readonly noAnswer: readonly NoAnswerQuestion[];
  /** The shared-view index entries the questions were resolved against, in index order. */
  readonly entries: readonly BrainIndexEntry[];
}

/**
 * Every answerable question becomes a golden whose expected ids are the chunks containing its
 * phrase. The chunker overlaps consecutive chunks of one section by 150 characters, so a phrase can
 * sit in two; both then count. A phrase found nowhere, or found in any other document, is refused.
 */
export function resolveDocsCorpusGoldens(brain: Brain, corpus: DocsCorpus): ResolvedDocsCorpus {
  const entries = loadBrainIndex({ profileDir: brain.profileDir, brain }).entries.filter((e) => e.seat === undefined);
  const answerable: DocsCorpusGolden[] = [];
  const noAnswer: NoAnswerQuestion[] = [];
  for (const q of corpus.questions) {
    if (q.category === "no_answer") {
      noAnswer.push(q);
      continue;
    }
    const phrase = normalisePhrase(q.phrase);
    const hits = entries.filter((e) => normalisePhrase(e.text).includes(phrase));
    const expectedPath = corpusDocPath(q.file);
    if (hits.length === 0) throw fixtureError(`question ${q.id}: its phrase is in no chunk of the corpus`, q.id);
    const strays = [...new Set(hits.filter((e) => e.path !== expectedPath).map((e) => e.path))];
    if (strays.length > 0) throw fixtureError(`question ${q.id}: its phrase is also in ${strays.join(", ")}, so it does not name one page`, q.id);
    answerable.push({ id: q.id, query: q.query, category: q.category, file: q.file, expected_chunk_ids: hits.map((e) => e.id) });
  }
  return { answerable, noAnswer, entries };
}
