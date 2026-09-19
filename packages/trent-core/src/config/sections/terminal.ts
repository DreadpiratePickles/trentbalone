/**
 * The `terminal` and `egress` blocks of `TrentConfigSchema`. Composed in `config/schema.ts`,
 * which re-exports every name here.
 */

import { z } from "zod";
import { SANDBOX_IMAGE } from "../../terminal/sandbox-image.js";

export const TerminalBackendSchema = z.enum(["docker", "local"]);
export type TerminalBackendType = z.infer<typeof TerminalBackendSchema>;

export const TerminalConfigSchema = z.object({
  backend: TerminalBackendSchema.default("docker"),
  docker: z
    .object({
      image: z.string().default(SANDBOX_IMAGE),
      network: z.string().default("bridge"),
    })
    .default({}),
  ssh: z
    .object({
      host: z.string().optional(),
      port: z.number().default(22),
      user: z.string().optional(),
      key_path: z.string().optional(),
    })
    .default({}),
});

export const EgressConfigSchema = z.object({
  enabled: z.boolean().default(true),
  proxy_port: z.number().default(8089),
  auto_token: z.boolean().default(true),
  intercept_domains: z.array(z.string()).default(["api.openai.com", "api.anthropic.com", "generativelanguage.googleapis.com"]),
});
