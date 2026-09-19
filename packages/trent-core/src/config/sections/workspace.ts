/**
 * The `workspace` block of `TrentConfigSchema`. Composed in `config/schema.ts`.
 */

import { z } from "zod";

// [A2.1] workspace context
/**
 * Caps on the instruction files Trent reads from the workspace it is run in (`AGENTS.md`,
 * `CLAUDE.md`, `.trent/*.md`). `max_file_chars` bounds one file, `max_total_chars` the set; a
 * file over either is truncated with a marker line, never dropped silently. Trust is not
 * configurable: it lives in `<profile>/workspace-trust.json` and is granted by
 * `trent workspace trust`. See docs/configuration.md, "Workspace context files".
 * The defaults must stay equal to `workspace-context/types.ts`, which is asserted by
 * `workspace-context/workspace-context.test.ts`.
 */
export const WorkspaceConfigSchema = z.object({
  max_file_chars: z.number().int().positive().default(12_000),
  max_total_chars: z.number().int().positive().default(24_000),
});
