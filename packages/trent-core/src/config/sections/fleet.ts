/**
 * The `fleet` block of `TrentConfigSchema`. Composed in `config/schema.ts`, which re-exports
 * every name here.
 */

import { z } from "zod";

export const FleetConfigSchema = z.object({
  installed_agents: z.array(z.string()).default(["ceo", "eng-ai-engineer", "support-responder"]),
  active_agents: z.array(z.string()).default(["ceo"]),
  default_agent: z.string().default("ceo"),
});
