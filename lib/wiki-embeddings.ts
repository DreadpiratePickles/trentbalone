/**
 * Wiki Embeddings — vector memory for the Obsidian-style wiki.
 *
 * Strategy:
 *  • On every note create/update, we chunk the markdown and request
 *    embeddings via the OpenAI-compatible bridge (text-embedding-3-small).
 *  • Vectors are persisted to a JSONL file in dev (data/embeddings.jsonl)
 *    so they survive restarts. In prod, swap in pgvector via the existing
 *    Postgres store (table sketched in WIKI EMBEDDINGS section of PRD).
 *  • Retrieval: cosine similarity top-K with hybrid keyword boost.
 *  • Falls back to deterministic hash-vectors when OPENAI_API_KEY is unset
 *    — keeps the dev path zero-config and deterministic for tests.
 */

import OpenAI from "openai";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";

const EMBED_MODEL = process.env.EMBEDDING_MODEL ?? "text-embedding-3-small";
const EMBED_DIM = 384; // Truncated; bridge returns 1536, we keep first 384 for speed/disk.
const CHUNK_CHARS = 1200;
const CHUNK_OVERLAP = 200;
const MAX_K = 6;
const STORE_PATH = process.env.WIKI_EMBED_STORE
  ?? path.join(process.cwd(), "data", "wiki-embeddings.jsonl");

export type EmbeddingRecord = {
  id: string;            // {noteId}#{chunkIdx}
  noteId: string;
  companyId: string;
  chunkIdx: number;
  title: string;
  path: string;
  text: string;          // Original chunk text
  vector: number[];
  updatedAt: string;
};

// ── In-memory cache, lazily hydrated from disk ────────────────────────────────

const globalForVec = globalThis as unknown as { __trentWikiEmbeds?: EmbeddingRecord[]; __trentWikiEmbedsLoaded?: boolean };
const records: EmbeddingRecord[] = globalForVec.__trentWikiEmbeds ?? [];
globalForVec.__trentWikiEmbeds = records;
let loaded = globalForVec.__trentWikiEmbedsLoaded ?? false;

async function loadFromDisk(): Promise<void> {
  if (loaded) return;
  try {
    const raw = await fs.readFile(STORE_PATH, "utf8");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try { records.push(JSON.parse(line)); } catch {}
    }
  } catch { /* fresh start */ }
  loaded = true;
  globalForVec.__trentWikiEmbedsLoaded = true;
}

async function persistAppend(rows: EmbeddingRecord[]): Promise<void> {
  await fs.mkdir(path.dirname(STORE_PATH), { recursive: true }).catch(() => {});
  const lines = rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
  await fs.appendFile(STORE_PATH, lines).catch((err) => {
    console.warn("wiki-embeddings: persist failed", err.message);
  });
}

async function persistRewrite(): Promise<void> {
  await fs.mkdir(path.dirname(STORE_PATH), { recursive: true }).catch(() => {});
  const lines = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
  await fs.writeFile(STORE_PATH, lines).catch((err) => {
    console.warn("wiki-embeddings: rewrite failed", err.message);
  });
}

// ── Chunking ─────────────────────────────────────────────────────────────────

function chunk(text: string): string[] {
  const cleaned = text.replace(/\r\n/g, "\n").trim();
  if (cleaned.length <= CHUNK_CHARS) return [cleaned];
  const out: string[] = [];
  let i = 0;
  while (i < cleaned.length) {
    out.push(cleaned.slice(i, i + CHUNK_CHARS));
    i += CHUNK_CHARS - CHUNK_OVERLAP;
  }
  return out;
}

// ── Embedding generation ─────────────────────────────────────────────────────

function deterministicVector(s: string, dim = EMBED_DIM): number[] {
  // Hash → repeatable pseudo-vector for offline/dev mode.
  const out = new Array<number>(dim).fill(0);
  let acc = createHash("sha256").update(s).digest();
  for (let i = 0; i < dim; i++) {
    if (i % 32 === 0 && i > 0) acc = createHash("sha256").update(acc).digest();
    out[i] = ((acc[i % 32] - 128) / 128);
  }
  // Normalize
  const norm = Math.sqrt(out.reduce((s, v) => s + v * v, 0)) || 1;
  return out.map((v) => v / norm);
}

async function embedMany(texts: string[]): Promise<number[][]> {
  if (!process.env.OPENAI_API_KEY) {
    return texts.map((t) => deterministicVector(t));
  }
  try {
    const client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      baseURL: process.env.OPENAI_BASE_URL || undefined,
      timeout: 30_000,
    });
    const resp = await client.embeddings.create({
      model: EMBED_MODEL,
      input: texts,
    });
    return resp.data.map((d) => {
      const v = (d.embedding as unknown as number[]).slice(0, EMBED_DIM);
      // Normalize for cosine similarity.
      const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
      return v.map((x) => x / norm);
    });
  } catch (err) {
    console.warn("wiki-embeddings: live embedding failed, using fallback —", err instanceof Error ? err.message : err);
    return texts.map((t) => deterministicVector(t));
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

export async function indexNote(input: {
  companyId: string;
  noteId: string;
  title: string;
  path: string;
  content: string;
}): Promise<{ chunks: number }> {
  await loadFromDisk();

  // Remove existing rows for this note (re-index).
  for (let i = records.length - 1; i >= 0; i--) {
    if (records[i].noteId === input.noteId) records.splice(i, 1);
  }

  const chunks = chunk(`${input.title}\n\n${input.content}`);
  if (chunks.length === 0) return { chunks: 0 };

  const vectors = await embedMany(chunks);
  const now = new Date().toISOString();
  const rows: EmbeddingRecord[] = chunks.map((text, idx) => ({
    id: `${input.noteId}#${idx}`,
    noteId: input.noteId,
    companyId: input.companyId,
    chunkIdx: idx,
    title: input.title,
    path: input.path,
    text,
    vector: vectors[idx],
    updatedAt: now,
  }));

  records.push(...rows);
  // Rewrite (idempotent) to keep file consistent with in-memory state.
  await persistRewrite();
  return { chunks: rows.length };
}

export async function removeNote(noteId: string): Promise<void> {
  await loadFromDisk();
  const before = records.length;
  for (let i = records.length - 1; i >= 0; i--) {
    if (records[i].noteId === noteId) records.splice(i, 1);
  }
  if (records.length !== before) await persistRewrite();
}

function cosine(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < len; i++) dot += a[i] * b[i];
  return dot; // vectors are L2-normalized
}

export async function semanticSearch(input: {
  companyId: string;
  query: string;
  k?: number;
}): Promise<Array<{ noteId: string; title: string; path: string; chunkIdx: number; text: string; score: number }>> {
  await loadFromDisk();
  const k = Math.min(Math.max(input.k ?? MAX_K, 1), 20);
  const [queryVec] = await embedMany([input.query]);
  const queryLower = input.query.toLowerCase();

  const scored = records
    .filter((r) => r.companyId === input.companyId)
    .map((r) => {
      const semantic = cosine(queryVec, r.vector);
      // Hybrid: small boost when the chunk contains query keywords.
      const lower = r.text.toLowerCase();
      const kwHits = queryLower.split(/\s+/).filter((w) => w.length > 3 && lower.includes(w)).length;
      const score = semantic + 0.04 * Math.min(3, kwHits);
      return {
        noteId: r.noteId,
        title: r.title,
        path: r.path,
        chunkIdx: r.chunkIdx,
        text: r.text,
        score,
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, k);

  return scored;
}

export async function stats(companyId: string): Promise<{ records: number; notes: number }> {
  await loadFromDisk();
  const own = records.filter((r) => r.companyId === companyId);
  return { records: own.length, notes: new Set(own.map((r) => r.noteId)).size };
}
