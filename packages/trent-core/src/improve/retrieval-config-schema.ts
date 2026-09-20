/**
 * [W3] The `retrieval` block of `config.yaml`: the floor the recall gate holds the ranker to.
 *
 * `min_recall` is the recall@8 over the profile's PROMOTED retrieval goldens below which the
 * improve loop refuses to promote and `trent improve retrieval` exits non-zero. 0.9 is the trigger
 * the design recorded for the deferred reranker and contextual prefixes (upgrade round design,
 * decision E): under it, retrieval is the problem to work on; over it, it is not.
 *
 * Defined beside the gate that reads it (`retrieval-gate.ts`) and composed into `config/schema.ts`
 * by one marked block, the way `gate`, `goals` and `checkpoints` are.
 */
import { z } from "zod";

export const RetrievalGateConfigSchema = z
  .object({
    /** recall@8 over the promoted retrieval goldens the ranker must reach. */
    min_recall: z.number().min(0).max(1).default(0.9),
  })
  .strict();

export type RetrievalGateConfig = z.infer<typeof RetrievalGateConfigSchema>;

export const RETRIEVAL_GATE_DEFAULTS: RetrievalGateConfig = { min_recall: 0.9 };
