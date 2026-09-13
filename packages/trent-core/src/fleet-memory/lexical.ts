/**
 * The offline ranker: the semantic router's lexical embedder (`apps/web/lib/semantic-router.ts`
 * `tokenize` / `buildLexicalIndex` / `lexicalVector`, which it does not export), reproduced here
 * so recall and search rank identically with no embedding key and no network. TF-IDF over the
 * candidate corpus, cosine similarity, fully deterministic for a given corpus.
 *
 * An `EmbedFn` can replace it (the router's real embedder when a key is present); the rest of
 * the module only ever sees scores.
 */

export type EmbedFn = (texts: readonly string[]) => Promise<number[][]>;

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

/** Similarity of `query` to each candidate, in candidate order. One embedding pass, one corpus. */
export async function scoreAgainst(query: string, candidates: readonly string[], embed: EmbedFn = lexicalEmbedFn): Promise<number[]> {
  if (candidates.length === 0) return [];
  const vectors = await embed([...candidates, query]);
  const q = vectors[vectors.length - 1]!;
  return candidates.map((_, i) => cosine(vectors[i]!, q));
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
