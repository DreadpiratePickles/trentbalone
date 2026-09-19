/**
 * The offline ranker: the semantic router's lexical embedder (`apps/web/lib/semantic-router.ts`
 * `tokenize` / `buildLexicalIndex` / `lexicalVector`, which it does not export), reproduced here
 * so recall and search rank identically with no embedding key and no network. TF-IDF over the
 * candidate corpus, cosine similarity, fully deterministic for a given corpus.
 *
 * An `EmbedFn` (C3: `embedder.ts`, the configured provider's embedding endpoint) does NOT replace
 * it — it JOINS it. `scoreAgainst` with an embedder returns the documented blend of both rankers
 * (`hybrid.ts`); without one it returns exactly what it returned before C3, byte for byte. The
 * rest of the module only ever sees scores.
 */

import { blendScores } from "./hybrid.js";

export type EmbedFn = (texts: readonly string[]) => Promise<number[][]>;

/**
 * An `EmbedFn` that knows its own model's unrelated-text baseline. The seam on
 * `createFleetMemoryHook` is a bare `EmbedFn` and stays one, so the calibration rides on the
 * function itself: `embedder.ts` sets it from `EMBEDDER_ROUTES[route].vectorFloor`, and an
 * embedder that does not declare one gets `HYBRID_VECTOR_FLOOR`.
 */
export interface CalibratedEmbedFn extends EmbedFn {
  readonly vectorFloor?: number;
}

const STOP_WORDS = new Set([
  "the", "and", "for", "with", "our", "your", "this", "that", "are", "was", "were", "from", "into",
  "then", "than", "please", "you", "not", "but", "can", "has", "have", "had", "will", "would",
  "should", "about", "over", "under", "one", "two", "all", "any", "its", "who", "what", "when",
  "how", "why", "where", "which", "there", "here", "step", "run", "task", "plan", "draft", "goal",
]);

function stemLite(word: string): string {
  if (word.endsWith("ing") && word.length > 5) return word.slice(0, -3);
  if (word.endsWith("tion") && word.length > 6) return word.slice(0, -4);
  if (word.endsWith("ly") && word.length > 4) return word.slice(0, -2);
  if (word.endsWith("es") && word.length > 4) return word.slice(0, -2);
  if (word.endsWith("s") && word.length > 4) return word.slice(0, -1);
  return word;
}

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w))
    .map(stemLite);
}

function normalize(v: number[]): number[] {
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

export function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) dot += a[i]! * b[i]!;
  return dot;
}

/**
 * True cosine, for vectors we did not normalise ourselves. `cosine` above is a bare dot product
 * and is correct only because `lexicalEmbed` returns unit vectors; a provider's embeddings are
 * not all unit length (Gemini's are not at every output dimension), so the vector term of the
 * hybrid blend divides by the magnitudes. A zero-length vector scores 0, never NaN.
 */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  const scale = Math.sqrt(na) * Math.sqrt(nb);
  return scale > 0 && Number.isFinite(dot) ? dot / scale : 0;
}

/** TF-IDF vectors over `texts`, the last of which may be the query; same vocabulary for all. */
export function lexicalEmbed(texts: readonly string[]): number[][] {
  const df = new Map<string, number>();
  const tokenized = texts.map((t) => tokenize(t));
  for (const tokens of tokenized) for (const t of new Set(tokens)) df.set(t, (df.get(t) ?? 0) + 1);
  const vocab = [...df.keys()].sort();
  const n = texts.length || 1;
  const idf = new Map<string, number>();
  for (const [t, count] of df) idf.set(t, Math.log(1 + n / (1 + count)));
  return tokenized.map((tokens) => {
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    return normalize(vocab.map((term) => {
      const freq = tf.get(term) ?? 0;
      return freq === 0 ? 0 : (1 + Math.log(freq)) * (idf.get(term) ?? 1);
    }));
  });
}

export const lexicalEmbedFn: EmbedFn = async (texts) => lexicalEmbed(texts);

/**
 * Similarity of `query` to each candidate, in candidate order. One pass per ranker, one corpus.
 *
 * No `embed`: TF-IDF alone, unchanged since before C3 — the lexical suites pin this path.
 * With `embed`: the documented blend of TF-IDF and the embedding cosine (`hybrid.ts`). An
 * embedder that fails is NOT allowed to fail a run: recall degrades to the lexical order it
 * would have had, because a missing vector index is worse context, not a broken company.
 */
export async function scoreAgainst(query: string, candidates: readonly string[], embed?: EmbedFn): Promise<number[]> {
  if (candidates.length === 0) return [];
  const corpus = [...candidates, query];
  const lexicalVectors = lexicalEmbed(corpus);
  const lexicalQuery = lexicalVectors[lexicalVectors.length - 1]!;
  const lexical = candidates.map((_, i) => cosine(lexicalVectors[i]!, lexicalQuery));
  if (embed === undefined) return lexical;

  let vectors: number[][];
  try {
    vectors = await embed(corpus);
  } catch {
    return lexical;
  }
  const vectorQuery = vectors[vectors.length - 1];
  if (vectorQuery === undefined || vectorQuery.length === 0) return lexical;
  const cosines = candidates.map((_, i) => {
    const v = vectors[i];
    return v === undefined || v.length === 0 ? undefined : cosineSimilarity(v, vectorQuery);
  });
  const floor = (embed as CalibratedEmbedFn).vectorFloor;
  return floor === undefined ? blendScores(lexical, cosines) : blendScores(lexical, cosines, floor);
}

/** Plain full-text score for search: how many distinct query tokens the text contains, then density. */
export function fullTextScore(query: string, text: string): number {
  const wanted = new Set(tokenize(query));
  if (wanted.size === 0) return 0;
  const have = tokenize(text);
  const present = new Set(have.filter((t) => wanted.has(t)));
  if (present.size === 0) return 0;
  const hits = have.filter((t) => wanted.has(t)).length;
  return present.size / wanted.size + Math.min(0.5, hits / Math.max(have.length, 1));
}
