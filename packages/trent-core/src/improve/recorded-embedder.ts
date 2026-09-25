/**
 * [P2-6] Recorded embeddings: how the docs-corpus suite measures the SHIPPED hybrid ranker in CI,
 * with no key and no network.
 *
 * What is recorded is not the vectors. `gemini-embedding-001` returns 3,072 dimensions, so the 625
 * chunks of the corpus would be about 10 MB of fixture. What the ranker CONSUMES of a vector is one
 * number per (question, chunk) pair — the cosine `scoreAgainst` computes with `cosineSimilarity`
 * before the calibrated blend (`hybrid.ts`) — so that is what a live run records: every question's
 * cosine against every chunk, from the live vectors, as float32.
 *
 * Replay rebuilds vectors with exactly those cosines. The query becomes `(1, 0)` and a chunk with
 * cosine `c` becomes `(c, sqrt(1 - c^2))`; `cosineSimilarity` of the two is `c`. Everything after
 * the embed call — the floor, the rescale, the 0.6/0.4 blend, `recallMinScore`, the sort — is the
 * shipped code running unchanged. It relies on `scoreAgainst` handing the embedder
 * `[...candidates, query]` with the query LAST (`lexical.ts`); a recording that does not cover a
 * text is counted in `stats()`, because `scoreAgainst` swallows an embedder failure and falls back
 * to lexical order, and a suite that did not look would measure the wrong ranker and call it hybrid.
 *
 * Keys are the first 16 hex characters of the sha256 of the exact text the embedder is handed, so
 * a change to the chunker, the importer or the text the ranker scores misses the recording loudly
 * and has to be re-recorded (`docs-corpus.live.test.ts`, about 2 cents) — which is the point.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import { z } from "zod";

import { EXIT, TrentError } from "../errors/index.js";
import { cosineSimilarity, type CalibratedEmbedFn, type EmbedFn } from "../fleet-memory/lexical.js";

export const RECORDED_COSINES_FILE = "embeddings.json";

const Key = z.string().regex(/^[0-9a-f]{16}$/);

const RecordedCosinesSchema = z
  .object({
    version: z.literal(1),
    provider: z.string().min(1),
    model: z.string().min(1),
    /** The embedder route's calibrated floor (`EMBEDDER_ROUTES[route].vectorFloor`), replayed with it. */
    vector_floor: z.number().min(0).max(0.99),
    captured_at: z.string().min(1),
    note: z.string(),
    /** Text keys of the chunks, in column order. */
    chunks: z.array(Key).min(1),
    /** Query text key to its row: base64 of float32 cosines, one per chunk column. */
    queries: z.record(Key, z.string().min(1)),
  })
  .strict();

export type RecordedCosines = z.infer<typeof RecordedCosinesSchema>;

export function textKey(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
}

function encodeRow(values: readonly number[]): string {
  return Buffer.from(Float32Array.from(values).buffer).toString("base64");
}

function decodeRow(encoded: string, columns: number, key: string): Float32Array {
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.byteLength !== columns * 4) {
    throw new TrentError({ code: EXIT.CONFIG, operation: "improve.recorded_embeddings", message: `row ${key} holds ${String(bytes.byteLength / 4)} cosines for ${String(columns)} chunks`, target: key });
  }
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return new Float32Array(copy);
}

export function readRecordedCosines(file: string): RecordedCosines {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  } catch (cause) {
    throw new TrentError({ code: EXIT.CONFIG, operation: "improve.recorded_embeddings", message: `cannot read ${file}`, target: file, cause });
  }
  return RecordedCosinesSchema.parse(raw);
}

/** One row per line, so a re-recording diffs by question. */
export function writeRecordedCosines(file: string, table: RecordedCosines): void {
  const { queries, chunks, ...head } = RecordedCosinesSchema.parse(table);
  const lines = Object.entries(queries).map(([key, row]) => `    ${JSON.stringify(key)}: ${JSON.stringify(row)}`);
  const headLines = Object.entries(head).map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)},`);
  const body = `{\n${headLines.join("\n")}\n  "chunks": ${JSON.stringify(chunks)},\n  "queries": {\n${lines.join(",\n")}\n  }\n}\n`;
  fs.writeFileSync(file, body, "utf8");
}

export interface RecordCosinesInput {
  /** The live embedder, exactly as the ranker would be handed it. */
  readonly embed: EmbedFn;
  readonly chunkTexts: readonly string[];
  readonly queries: readonly string[];
  readonly provider: string;
  readonly model: string;
  readonly vectorFloor: number;
  readonly capturedAt: string;
  readonly note: string;
}

function distinct(texts: readonly string[]): string[] {
  const seen = new Map<string, string>();
  for (const text of texts) {
    const key = textKey(text);
    const prior = seen.get(key);
    if (prior !== undefined && prior !== text) {
      throw new TrentError({ code: EXIT.CONFIG, operation: "improve.recorded_embeddings", message: `two different texts share the key ${key}`, target: key });
    }
    seen.set(key, text);
  }
  return [...seen.values()];
}

/** Embeds every chunk and question once and records each question's cosine against each chunk. */
export async function recordCosines(input: RecordCosinesInput): Promise<RecordedCosines> {
  const chunks = distinct(input.chunkTexts);
  const queries = distinct(input.queries);
  const chunkVectors = await input.embed(chunks);
  const queryVectors = await input.embed(queries);
  const missing = [...chunkVectors, ...queryVectors].filter((v) => v === undefined || v.length === 0).length;
  if (chunkVectors.length !== chunks.length || queryVectors.length !== queries.length || missing > 0) {
    throw new TrentError({ code: EXIT.PROVIDER, operation: "improve.recorded_embeddings", message: `the embedder returned ${String(missing)} empty vectors; nothing was recorded` });
  }
  const rows: Record<string, string> = {};
  queries.forEach((query, j) => {
    rows[textKey(query)] = encodeRow(chunkVectors.map((v) => cosineSimilarity(v, queryVectors[j]!)));
  });
  return {
    version: 1,
    provider: input.provider,
    model: input.model,
    vector_floor: input.vectorFloor,
    captured_at: input.capturedAt,
    note: input.note,
    chunks: chunks.map(textKey),
    queries: rows,
  };
}

export interface RecordedEmbedStats {
  readonly calls: number;
  /** Queries the recording has no row for; each such call degraded to lexical inside `scoreAgainst`. */
  readonly missingQueries: readonly string[];
  /** Candidate texts the recording has no column for; each scored lexical-only. */
  readonly missingChunks: number;
}

export interface RecordedEmbedFn extends CalibratedEmbedFn {
  stats(): RecordedEmbedStats;
}

/** An `EmbedFn` that replays a recording through the shipped scoring code; never the network. */
export function recordedEmbedFn(table: RecordedCosines): RecordedEmbedFn {
  const columns = new Map(table.chunks.map((key, i) => [key, i] as const));
  const rows = new Map(Object.entries(table.queries).map(([key, row]) => [key, decodeRow(row, table.chunks.length, key)] as const));
  let calls = 0;
  let missingChunks = 0;
  const missingQueries = new Set<string>();

  const embed: EmbedFn = async (texts) => {
    calls += 1;
    const query = texts[texts.length - 1] ?? "";
    const row = rows.get(textKey(query));
    if (row === undefined) {
      missingQueries.add(query);
      throw new TrentError({ code: EXIT.CONFIG, operation: "improve.recorded_embeddings", message: "no recorded cosines for this query; re-record the docs corpus", target: textKey(query) });
    }
    return texts.map((text, i) => {
      if (i === texts.length - 1) return [1, 0];
      const column = columns.get(textKey(text));
      if (column === undefined) {
        missingChunks += 1;
        return [];
      }
      const c = Math.max(-1, Math.min(1, row[column]!));
      return [c, Math.sqrt(1 - c * c)];
    });
  };
  return Object.assign(embed, {
    vectorFloor: table.vector_floor,
    stats: (): RecordedEmbedStats => ({ calls, missingQueries: [...missingQueries], missingChunks }),
  });
}
