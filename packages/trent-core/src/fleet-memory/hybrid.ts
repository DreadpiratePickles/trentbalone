/**
 * The hybrid blend: how a lexical score and an embedding cosine become ONE number that
 * `recall.ts` can still compare against `recallMinScore`.
 *
 * Pure arithmetic on two aligned arrays, with no import of its own, so `lexical.ts` can use it
 * without a cycle and a reader can check the numbers without reading a ranker.
 *
 * ── The weights, and why they are what they are ──────────────────────────────────────────────
 *
 * `HYBRID_VECTOR_WEIGHT` 0.6, `HYBRID_LEXICAL_WEIGHT` 0.4. They sum to 1, so a blended score
 * stays on the same 0..1 scale the lexical-only score was on and `recallMinScore` (0.12) keeps
 * meaning what it meant before an embedder existed.
 *
 * The vector term has to be the majority, because the whole point of adding it is the case the
 * lexical ranker gets wrong: an objective about churn and a step output about retention share no
 * token after stemming, while a sentence about a "monthly subscription tier" for office parking
 * shares four. With the weights the other way round the paraphrase cannot overtake the collision —
 * the collision's lexical score is high and the paraphrase's is zero, so the vector term must be
 * able to outweigh a full-strength lexical hit on its own. It cannot be the ONLY term either:
 * TF-IDF is the ranker that gets an exact identifier, an error code or a customer name right, and
 * an embedding flattens exactly those. 0.6/0.4 is the smallest vector majority that satisfies
 * both — `hybrid.test.ts` asserts the resulting order in both directions.
 *
 * The FLOOR is the second half of the design, and it is per model. Real embedding models do not
 * put unrelated text near cosine 0. Measured on Bobby's key by `embedder.live.test.ts`,
 * `gemini-embedding-001` scores an unrelated sentence 0.529 and a paraphrase 0.754; OpenAI's
 * `text-embedding-3-small` sits far lower on both. Feeding the raw cosine into the blend would
 * therefore hand every candidate on a Gemini key a free 0.3 and turn "this run recalls nothing"
 * into "this run recalls whatever exists". So a cosine at or below the floor earns NOTHING and
 * the band above it is rescaled onto 0..1, and the floor travels with the embedder
 * (`embedder.ts`, `EMBEDDER_ROUTES[route].vectorFloor`) rather than being one global number.
 *
 * The floor is absolute rather than relative to the corpus on purpose: a min-max over the
 * candidates would give the best of an entirely unrelated corpus full credit, so every run would
 * recall something. `HYBRID_VECTOR_FLOOR` below is only the default for an embedder that declares
 * no floor of its own.
 */

/** Weight on the offline TF-IDF score. */
export const HYBRID_LEXICAL_WEIGHT = 0.4;
/** Weight on the embedding cosine, after the floor and the rescale below. */
export const HYBRID_VECTOR_WEIGHT = 0.6;
/** Default cosine floor, for an embedder that declares none. Below it two texts are unrelated. */
export const HYBRID_VECTOR_FLOOR = 0.35;

/** The 0..1 share of `HYBRID_VECTOR_WEIGHT` one cosine earns. Anything unusable earns none. */
export function vectorCredit(cosine: number, floor: number = HYBRID_VECTOR_FLOOR): number {
  const bound = Number.isFinite(floor) ? Math.min(Math.max(floor, 0), 0.99) : HYBRID_VECTOR_FLOOR;
  if (!Number.isFinite(cosine) || cosine <= bound) return 0;
  return Math.min(1, (cosine - bound) / (1 - bound));
}

/**
 * Blend two aligned score arrays. A candidate with no cosine (a vector the provider did not
 * return) keeps its lexical score alone rather than being pushed down by a missing term.
 */
export function blendScores(
  lexical: readonly number[],
  cosines: readonly (number | undefined)[],
  floor: number = HYBRID_VECTOR_FLOOR,
): number[] {
  return lexical.map((score, i) => {
    const cosine = cosines[i];
    const lexicalPart = HYBRID_LEXICAL_WEIGHT * (Number.isFinite(score) ? score : 0);
    if (cosine === undefined) return Number.isFinite(score) ? score : 0;
    return lexicalPart + HYBRID_VECTOR_WEIGHT * vectorCredit(cosine, floor);
  });
}
