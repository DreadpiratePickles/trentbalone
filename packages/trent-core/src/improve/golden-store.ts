/**
 * [D1] the goldens directory as a reviewable store.
 *
 * A failure golden is a JSON file the capture wrote under `<profileDir>/goldens`
 * (`golden-capture.ts` wraps `apps/web/lib/orchestration-golden-capture.ts`, which owns the
 * format and the redaction). This module is the read and review side the command line needs:
 * list what was captured, and record a human's decision on one.
 *
 * The file's vocabulary is the application's — a promoted golden is `blocking`, because that is
 * what the app's own suite runner filters on — and the loop's vocabulary is `quarantined`,
 * `promoted`, `rejected`. `reviewOf` is the one place the two meet, so nothing else has to know.
 *
 * Reads go through `node:fs` rather than the app's lister: the profile's goldens are plain files,
 * and a CLI listing must not drag the app's audit log and its database client in behind it.
 *
 * Writing here is a HUMAN command (`trent improve goldens promote|reject`). The loop itself may
 * never write this directory — `frozen-surface.ts` freezes `<profileDir>/goldens` as class
 * `golden`, and that refusal is what keeps the loop from promoting its own exam.
 */

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { EXIT, TrentError } from "../errors/index.js";

/** What a human decided about a golden. The loop's vocabulary. */
export type GoldenReview = "quarantined" | "promoted" | "rejected";

/** The status the application writes for a golden a human promoted. */
export const PROMOTED_ON_DISK = "blocking";

/**
 * One captured golden, as the app's `CapturedOrchestrationGolden` writes it, plus the fields a
 * reviewer may add by hand. Everything optional is absent on a capture the app wrote itself.
 */
export interface StoredGolden {
  readonly id: string;
  readonly runId: string;
  readonly companyId?: string;
  /** Sanitised by the capture; this is what re-runs as the fixture prompt. */
  readonly objective: string;
  readonly reason: string;
  readonly status: string;
  readonly trajectoryFailureTags?: readonly string[];
  readonly capturedAt?: string;
  readonly promotedAt?: string;
  readonly rejectedAt?: string;
  /** Seats this golden belongs to, when a reviewer named them; otherwise the run's traces decide. */
  readonly seats?: readonly string[];
  /** Natural-language assertions a reviewer added; each becomes one rubric grader. */
  readonly assertions?: readonly string[];
  readonly contains?: readonly string[];
  readonly required_tools?: readonly string[];
  readonly forbidden_tools?: readonly string[];
}

/** Where a profile keeps its captured goldens. The capture writes here; the loop may not. */
export function goldensDir(profileDir: string): string {
  return path.join(profileDir, "goldens");
}

/** Reads the on-disk status of either kind of golden; the retrieval kind shares the vocabulary. */
export function reviewOf(golden: Pick<StoredGolden, "status">): GoldenReview {
  if (golden.status === PROMOTED_ON_DISK || golden.status === "promoted") return "promoted";
  if (golden.status === "rejected") return "rejected";
  return "quarantined";
}

export function promotedGoldens(goldens: readonly StoredGolden[]): StoredGolden[] {
  return goldens.filter((golden) => reviewOf(golden) === "promoted");
}

export function quarantinedGoldens(goldens: readonly StoredGolden[]): StoredGolden[] {
  return goldens.filter((golden) => reviewOf(golden) === "quarantined");
}

function parseGolden(raw: string): StoredGolden | undefined {
  try {
    const parsed = JSON.parse(raw) as Partial<StoredGolden>;
    if (typeof parsed.id !== "string" || typeof parsed.objective !== "string" || typeof parsed.runId !== "string") return undefined;
    return {
      ...parsed,
      id: parsed.id,
      runId: parsed.runId,
      objective: parsed.objective,
      reason: typeof parsed.reason === "string" ? parsed.reason : "",
      status: typeof parsed.status === "string" ? parsed.status : "quarantined",
    };
  } catch {
    return undefined;
  }
}

/** Every golden in the directory, oldest file name first. A missing directory is no goldens. */
export async function listGoldens(dir: string): Promise<StoredGolden[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  const goldens: StoredGolden[] = [];
  for (const entry of entries.filter((name) => name.endsWith(".json")).sort()) {
    const golden = parseGolden(await fs.readFile(path.join(dir, entry), "utf8").catch(() => ""));
    if (golden) goldens.push(golden);
  }
  return goldens;
}

/** The file a golden lives in, found by id rather than guessed from the run id. */
async function fileFor(dir: string, goldenId: string): Promise<{ file: string; golden: StoredGolden }> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    entries = [];
  }
  for (const entry of entries.filter((name) => name.endsWith(".json")).sort()) {
    const file = path.join(dir, entry);
    const golden = parseGolden(await fs.readFile(file, "utf8").catch(() => ""));
    if (golden?.id === goldenId) return { file, golden };
  }
  throw new TrentError({ code: EXIT.USAGE, operation: "improve.goldens", message: `no captured golden ${goldenId} under ${dir}`, target: goldenId });
}

export async function getGolden(dir: string, goldenId: string): Promise<StoredGolden> {
  return (await fileFor(dir, goldenId)).golden;
}

/**
 * Record a human's decision. The review timestamp is written beside the status so
 * `trent improve goldens list` can show when a suite last changed shape.
 */
export async function setGoldenStatus(dir: string, goldenId: string, review: GoldenReview, now: string): Promise<StoredGolden> {
  const { file, golden } = await fileFor(dir, goldenId);
  const updated: StoredGolden = {
    ...golden,
    status: review === "promoted" ? PROMOTED_ON_DISK : review,
    ...(review === "promoted" ? { promotedAt: now } : {}),
    ...(review === "rejected" ? { rejectedAt: now } : {}),
  };
  await fs.writeFile(file, `${JSON.stringify(updated, null, 2)}\n`, "utf8");
  return updated;
}

// [W3] the `retrieval` kind
/**
 * A retrieval golden is a query and the chunk ids the ranker must put in its top k
 * (`docs/improve.md`, "Retrieval goldens and the recall gate"). It is the other thing a suite
 * can grow from without anyone authoring an exam: a founder names a chunk they know the answer
 * sits in (`trent improve goldens add --retrieval`), or a run produces one when a seat calls
 * `brain_read` on a chunk id its own recall had ranked (`retrieval-capture.ts`). Both start
 * quarantined; only a promoted one is scored. The files live under the goldens tree, in their
 * own directory, so `listGoldens` never mistakes one for a failure golden and the frozen surface
 * covers both with one rule.
 */
export const RETRIEVAL_GOLDENS_SUBDIR = "retrieval";
export const RETRIEVAL_GOLDEN_KIND = "retrieval";

export type RetrievalGoldenSource = "founder" | "captured";

export interface RetrievalGoldenInput {
  readonly query: string;
  /** Chunk ids (`lease#7`); a hit is any one of them in the top k. */
  readonly expected_chunk_ids: readonly string[];
  /** A document named by slug, and optionally a page, when the exact chunk is not known. */
  readonly expected_doc?: { readonly slug: string; readonly page?: number };
  readonly source: RetrievalGoldenSource;
  /** The seat whose view the query is ranked for; the shared view when absent. */
  readonly seat?: string;
  /** The run a captured golden came from. */
  readonly runId?: string;
}

export interface RetrievalGolden extends RetrievalGoldenInput {
  readonly id: string;
  readonly kind: typeof RETRIEVAL_GOLDEN_KIND;
  readonly status: string;
  readonly capturedAt: string;
  readonly promotedAt?: string;
  readonly rejectedAt?: string;
}

export function retrievalGoldensDir(profileDir: string): string {
  return path.join(goldensDir(profileDir), RETRIEVAL_GOLDENS_SUBDIR);
}

/** Content-addressed: the same query and expectation is the same golden however often it is captured. */
export function retrievalGoldenId(query: string, expected: readonly string[], doc?: RetrievalGoldenInput["expected_doc"]): string {
  const hash = createHash("sha256")
    .update(`${query.trim()}\n${[...expected].sort().join("\n")}\n${doc === undefined ? "" : `${doc.slug}#p${doc.page ?? ""}`}`)
    .digest("hex");
  return `rgold_${hash.slice(0, 16)}`;
}

function parseRetrievalGolden(raw: string): RetrievalGolden | undefined {
  try {
    const parsed = JSON.parse(raw) as Partial<RetrievalGolden>;
    if (parsed.kind !== RETRIEVAL_GOLDEN_KIND || typeof parsed.id !== "string" || typeof parsed.query !== "string") return undefined;
    if (!Array.isArray(parsed.expected_chunk_ids)) return undefined;
    return {
      ...parsed,
      id: parsed.id,
      kind: RETRIEVAL_GOLDEN_KIND,
      query: parsed.query,
      expected_chunk_ids: parsed.expected_chunk_ids.filter((id): id is string => typeof id === "string"),
      source: parsed.source === "founder" ? "founder" : "captured",
      status: typeof parsed.status === "string" ? parsed.status : "quarantined",
      capturedAt: typeof parsed.capturedAt === "string" ? parsed.capturedAt : "",
    };
  } catch {
    return undefined;
  }
}

function retrievalFile(dir: string, id: string): string {
  return path.join(dir, `retrieval-${id}.json`);
}

export async function listRetrievalGoldens(dir: string): Promise<RetrievalGolden[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  const goldens: RetrievalGolden[] = [];
  for (const entry of entries.filter((name) => name.endsWith(".json")).sort()) {
    const golden = parseRetrievalGolden(await fs.readFile(path.join(dir, entry), "utf8").catch(() => ""));
    if (golden) goldens.push(golden);
  }
  return goldens;
}

export function promotedRetrievalGoldens(goldens: readonly RetrievalGolden[]): RetrievalGolden[] {
  return goldens.filter((golden) => reviewOf(golden) === "promoted");
}

export async function getRetrievalGolden(dir: string, goldenId: string): Promise<RetrievalGolden> {
  const golden = (await listRetrievalGoldens(dir)).find((candidate) => candidate.id === goldenId);
  if (!golden) throw new TrentError({ code: EXIT.USAGE, operation: "improve.goldens", message: `no retrieval golden ${goldenId} under ${dir}`, target: goldenId });
  return golden;
}

async function writeRetrievalGolden(dir: string, golden: RetrievalGolden): Promise<void> {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.writeFile(retrievalFile(dir, golden.id), `${JSON.stringify(golden, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

/**
 * Add one, quarantined. A golden that already exists is returned as it is — with the review a
 * human already gave it — so a second capture of the same read can never reopen a decision.
 */
export async function addRetrievalGolden(dir: string, input: RetrievalGoldenInput, now: string): Promise<RetrievalGolden> {
  const id = retrievalGoldenId(input.query, input.expected_chunk_ids, input.expected_doc);
  const existing = (await listRetrievalGoldens(dir)).find((candidate) => candidate.id === id);
  if (existing) return existing;
  const golden: RetrievalGolden = { ...input, query: input.query.trim(), expected_chunk_ids: [...input.expected_chunk_ids], id, kind: RETRIEVAL_GOLDEN_KIND, status: "quarantined", capturedAt: now };
  await writeRetrievalGolden(dir, golden);
  return golden;
}

/** A human's decision on a retrieval golden, recorded the same way as on a failure golden. */
export async function setRetrievalGoldenStatus(dir: string, goldenId: string, review: GoldenReview, now: string): Promise<RetrievalGolden> {
  const golden = await getRetrievalGolden(dir, goldenId);
  const updated: RetrievalGolden = {
    ...golden,
    status: review === "promoted" ? PROMOTED_ON_DISK : review,
    ...(review === "promoted" ? { promotedAt: now } : {}),
    ...(review === "rejected" ? { rejectedAt: now } : {}),
  };
  await writeRetrievalGolden(dir, updated);
  return updated;
}
