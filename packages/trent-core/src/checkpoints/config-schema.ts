/**
 * E1 — the `checkpoints` config block, defined beside the ledger that reads it.
 *
 * `enabled` false records nothing and creates no directory, which also means no write made while
 * it was off can ever be undone. `max_bytes_per_run` caps the pre-image bytes one run may store
 * under `<profile>/checkpoints/<run_id>/`: past it a row still carries both hashes and says why
 * it carries no bytes, and that path is refused at rollback rather than restored from something
 * approximate. The default IS `DEFAULT_MAX_BYTES_PER_RUN`, not a copy of it, so the documented
 * ceiling and the enforced one cannot drift; `checkpoints/config.test.ts` asserts that too.
 *
 * It lives here rather than in `config/schema.ts` so the block costs that file three lines: the
 * schema is already at the repository's 500-line ceiling. See docs/checkpoints.md.
 */

import { z } from "zod";
import { DEFAULT_MAX_BYTES_PER_RUN } from "./types.js";

export const CheckpointsConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    max_bytes_per_run: z.number().int().positive().default(DEFAULT_MAX_BYTES_PER_RUN),
  })
  .strict();

export type CheckpointsConfig = z.infer<typeof CheckpointsConfigSchema>;
