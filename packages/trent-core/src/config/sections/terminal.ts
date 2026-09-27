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
      // [SEC-1/T-01] The `network` key was removed: it never reached the sandbox (dead wiring — the
      // tool builder passed `docker: { image }` only), and the egress sandbox now runs behind a
      // per-seat `--internal` network + forwarder sidecar (see terminal/egress-network.ts), not a
      // configurable bridge. The isolated sandbox is always `--network none`.
      image: z.string().default(SANDBOX_IMAGE),
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
  // [T-04] `bsky.social` and `api.buffer.com` are the social toolset's two fixed provider hosts
  // (social publish); the model-provider hosts precede them. See config/defaults.ts.
  intercept_domains: z.array(z.string()).default(["api.openai.com", "api.anthropic.com", "generativelanguage.googleapis.com", "bsky.social", "api.buffer.com"]),
});
