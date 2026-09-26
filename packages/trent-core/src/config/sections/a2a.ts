/**
 * [P2-9] The `a2a:` block of `config.yaml`: the A2A peers the `a2a` toolset may reach
 * (docs/a2a.md, "Calling other agents").
 *
 * Each peer is a name the seat uses (`a2a_send {"peer": "hermes", ...}`), the URL its Agent Card
 * is discovered from, and optionally the NAME of the environment variable its bearer token lives
 * in. The value lives in the profile secrets file (`<profile>/.env`, 0600) and is read by that name
 * when a call is made; this block never holds one. So an entry is strict: a `token` key is an
 * error, not an ignored field, and `token_env` must be a name `trent config set` routes to the
 * secrets file (`config/secrets-policy.ts`: an env-shaped name ending `_TOKEN`, `_KEY`, `_SECRET`
 * or `_PASSWORD`), so following the error message can never put the value into this file.
 *
 * The peers' origins are the toolset's allowlist: a URL whose origin is not one of them is refused
 * before a socket opens. Every request also goes through the egress proxy, so a peer's host must be
 * in `egress.intercept_domains` as well.
 */
import { z } from "zod";

/** A peer's name: what a seat types, and part of every history row. */
export const A2A_PEER_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,40}$/;

/**
 * An env-var name that `trent config set` writes to the secrets file. Restated here rather than
 * imported, because `config/secrets-policy.ts` imports `config/schema.ts`, which composes this file.
 */
export const A2A_TOKEN_ENV_PATTERN = /^[A-Z][A-Z0-9_]*(_KEY|_TOKEN|_SECRET|_PASSWORD)$/;

export const A2aPeerSchema = z
  .object({
    name: z.string().regex(A2A_PEER_NAME_PATTERN, "peer name must match ^[a-z][a-z0-9_-]{0,40}$"),
    url: z
      .string()
      .url()
      .refine((url) => /^https?:\/\//i.test(url), { message: "url must be http(s)" }),
    token_env: z
      .string()
      .regex(A2A_TOKEN_ENV_PATTERN, "token_env is the NAME of a secrets-file variable ending _TOKEN, _KEY, _SECRET or _PASSWORD, never a value")
      .optional(),
  })
  .strict();

export type A2aPeer = z.infer<typeof A2aPeerSchema>;

export const A2aConfigSchema = z
  .object({
    peers: z
      .array(A2aPeerSchema)
      .superRefine((peers, ctx) => {
        const seen = new Set<string>();
        for (const [index, peer] of peers.entries()) {
          if (seen.has(peer.name)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [index, "name"], message: `peer name "${peer.name}" is used twice` });
          seen.add(peer.name);
        }
      })
      .default([]),
  })
  .strict();

export type A2aConfig = z.infer<typeof A2aConfigSchema>;
