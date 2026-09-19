/**
 * The `brain` block of `TrentConfigSchema`. Composed in `config/schema.ts`.
 */

import { z } from "zod";

// [C2] brain
/**
 * The brain repository, `<profile>/brain/` (docs/brain.md). Its files are the truth for
 * identity, standing decisions and episodic notes; the memory blocks migrate into
 * `brain/system/` on first use, and every index over it is disposable.
 *
 * `enabled` false means no `brain/` directory is ever created and no brain block reaches a
 * prompt; the memory blocks stay where they are. `versioning` `auto` uses git when it is on
 * PATH, so every write is a commit naming the seat that made it and the run it belonged to;
 * `off` never shells out and the brain is plain files, which `trent doctor` reports as a line,
 * not a failure. Versioning is for audit and rollback, never for merging concurrent writers —
 * that is the memory lock's job.
 */
export const BrainConfigSchema = z.object({
  enabled: z.boolean().default(true),
  versioning: z.enum(["auto", "off"]).default("auto"),
});
