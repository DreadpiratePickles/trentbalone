/**
 * [L0-5] The similarity floor of an embedding model: the cosine at or below which two texts are
 * unrelated (`hybrid.ts` gives no vector credit under it). Embedding spaces are anisotropic, so the
 * floor is measured per model, never assumed: three fixed triples (an objective, a paraphrase that
 * shares almost no words with it, and an unrelated sentence), the rule P2-13 set for Gemini, the
 * floors recorded for the models measured live, and the sanity score the doctor prints.
 */

import { cosineSimilarity, type EmbedFn, type EmbedRole } from "./lexical.js";

/**
 * Floors measured live on the three triples below by `embedder.live.test.ts` (local mode) and set by the
 * P2-13 rule, `max(unrelated) + 0.3 x (min(paraphrase) - max(unrelated))`, rounded up to hundredths.
 * `vectorFloor`: no prefixes. `queryFloor`: the query prefixed, documents as documents. Per model, never
 * per family: a different size or quantisation is a different space.
 */
export const RECORDED_LOCAL_FLOORS: Readonly<Record<string, { readonly vectorFloor: number; readonly queryFloor: number }>> = {
  // 2026-09-26, Ollama 0.32.9, Q8_0, 1024 dims. Symmetric: paraphrase 0.7125 / 0.7264 / 0.7570 against
  // unrelated 0.3432 / 0.2868 / 0.2763, so 0.3432 + 0.3 x 0.3693 = 0.454, up to 0.46. Query prefixed:
  // paraphrase 0.6025 / 0.6539 / 0.6085, unrelated 0.1957 / 0.1586 / 0.1801, so 0.318, up to 0.32.
  "qwen3-embedding:0.6b": { vectorFloor: 0.46, queryFloor: 0.32 },
};

/** Three fixed triples: an objective, a paraphrase sharing almost no words with it, and an unrelated line. */
export const CALIBRATION_TRIPLES: ReadonlyArray<{ readonly anchor: string; readonly paraphrase: string; readonly unrelated: string }> = [
  { anchor: "reduce monthly churn on the annual subscription tier", paraphrase: "stop yearly plan customers from cancelling every month", unrelated: "the warehouse forklift needs its hydraulic seals replaced before winter" },
  { anchor: "draft the launch announcement for the new mobile app", paraphrase: "write a press release introducing our phone application", unrelated: "the soil in the north field is too acidic for barley" },
  { anchor: "find out why invoice totals do not match the payments received", paraphrase: "reconcile what we billed against the money that actually came in", unrelated: "our team retreat is booked at a lakeside cabin in June" },
];

export interface CalibrationPair { readonly near: number; readonly far: number }

/** A floor at or below which a cosine means unrelated; undefined when the model cannot separate the triples. */
export function floorFromPairs(pairs: readonly CalibrationPair[]): number | undefined {
  if (pairs.length === 0) return undefined;
  const far = Math.max(...pairs.map((p) => p.far));
  const near = Math.min(...pairs.map((p) => p.near));
  if (!(near > far)) return undefined;
  const floor = Math.ceil((far + 0.3 * (near - far)) * 100) / 100;
  return floor < near ? floor : undefined;
}

/** How many triples a floor gets right: the paraphrase above it and the unrelated line at or below it. */
export function calibrationSanity(pairs: readonly CalibrationPair[], floor: number): number {
  return pairs.filter((p) => p.near > floor && p.far <= floor).length;
}

/** The three triples' cosines under `embed`; `asymmetric` embeds each anchor as the query, the rest as documents. */
export async function measureCalibration(embed: EmbedFn, asymmetric: boolean): Promise<CalibrationPair[]> {
  const texts = CALIBRATION_TRIPLES.flatMap((t) => [t.anchor, t.paraphrase, t.unrelated]);
  const roles: EmbedRole[] | undefined = asymmetric ? CALIBRATION_TRIPLES.flatMap((): EmbedRole[] => ["query", "document", "document"]) : undefined;
  const v = roles === undefined ? await embed(texts) : await embed(texts, { roles });
  return CALIBRATION_TRIPLES.map((_, i) => ({ near: cosineSimilarity(v[3 * i]!, v[3 * i + 1]!), far: cosineSimilarity(v[3 * i]!, v[3 * i + 2]!) }));
}

/** What a model that cannot tell a paraphrase from an unrelated sentence gets: no vector credit at all. */
export const UNSEPARABLE_FLOOR = 0.99;
