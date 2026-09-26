/**
 * The `gateway` block of `TrentConfigSchema`. Composed in `config/schema.ts`, which re-exports
 * every name here.
 */

import { z } from "zod";

// [H3] webhook routes
/**
 * `gateway.webhooks`: signed HTTP routes that START a run (`packages/trent-core/src/webhooks/`,
 * docs/webhooks.md). The signature is verified over the raw body before anything else is read;
 * `secret_env` names the environment variable holding the HMAC secret and is never the secret.
 * `objective_template` and `dedupe_key` take `{{payload.a.b}}` references into the JSON body and
 * nothing else. A `none-localhost-only` route takes no secret and answers only a loopback peer on a
 * loopback listener. The listener is the same `WebhookServer` the chat adapters use; a route may
 * not sit under their `/webhooks/` prefix.
 */
export const WEBHOOK_SIGNATURES = ["hmac-sha256", "stripe", "github", "none-localhost-only"] as const;
export const WEBHOOK_MODES = ["fleet", "solo"] as const;
export const ADAPTER_WEBHOOK_PREFIX = "/webhooks/";
export const DEFAULT_WEBHOOK_PORT = 8644;
const TEMPLATE_REF = /\{\{\s*([^{}]*?)\s*\}\}/g;
const PAYLOAD_REF = /^payload(?:\.[A-Za-z0-9_-]+)*$/;
const PROTOTYPE_SEGMENT = /(?:^|\.)(?:__proto__|constructor|prototype)(?:\.|$)/;
const LOOPBACK_HOSTS: readonly string[] = ["127.0.0.1", "::1", "localhost"];

/** The `{{...}}` references a template makes, trimmed, in order. */
export function webhookTemplateRefs(template: string): string[] {
  return [...template.matchAll(TEMPLATE_REF)].map((match) => match[1] ?? "");
}

/** References that are not a `payload` path, or that walk a prototype. */
export function badWebhookTemplateRefs(template: string): string[] {
  return webhookTemplateRefs(template).filter((ref) => !PAYLOAD_REF.test(ref) || PROTOTYPE_SEGMENT.test(ref));
}

export const WebhookRouteSchema = z
  .object({
    name: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, "a route name is lowercase letters, digits, - and _"),
    path: z
      .string()
      .regex(/^\/[A-Za-z0-9._~/-]{1,200}$/, "a route path starts with / and holds only URL-safe characters")
      .refine((value) => !value.startsWith(ADAPTER_WEBHOOK_PREFIX), `${ADAPTER_WEBHOOK_PREFIX} belongs to the chat adapters; use /hooks/<name>`),
    /** An environment variable NAME. Its value is the secret; the value never goes in config. */
    secret_env: z.string().regex(/^[A-Z_][A-Z0-9_]{0,127}$/, "secret_env is an environment variable NAME (A-Z, 0-9, _), never the secret").optional(),
    signature: z.enum(WEBHOOK_SIGNATURES),
    /** `hmac-sha256` only: the header carrying the hex digest. Default `x-webhook-signature`. */
    signature_header: z.string().regex(/^[A-Za-z0-9-]{1,64}$/).optional(),
    /** `stripe` only: how far `t=` may sit from this host's clock. */
    tolerance_seconds: z.number().int().positive().max(3600).default(300),
    objective_template: z.string().trim().min(1).max(8000),
    mode: z.enum(WEBHOOK_MODES).default("fleet"),
    seat: z.string().trim().min(1).max(100).optional(),
    /** Integer cents: the run is stopped when its metered frames reach this. */
    max_cost_cents: z.number().int().positive().optional(),
    /** A template naming the delivery; unset (or rendering empty), the raw body's SHA-256 is the key. */
    dedupe_key: z.string().trim().min(1).max(500).optional(),
    /** Accepted event names (GitHub's X-GitHub-Event, else the payload's `type`); unset accepts all. */
    events: z.array(z.string().trim().min(1)).min(1).optional(),
    /** Runs this route may start per rolling minute. */
    rate_per_minute: z.number().int().positive().max(600).default(30),
  })
  .superRefine((route, ctx) => {
    const issue = (path: string, message: string): void => ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
    if (route.signature === "none-localhost-only") {
      if (route.secret_env !== undefined) issue("secret_env", "a none-localhost-only route takes no secret");
    } else if (route.secret_env === undefined) {
      issue("secret_env", `a ${route.signature} route needs secret_env: the NAME of the variable holding its secret`);
    }
    if (route.signature_header !== undefined && route.signature !== "hmac-sha256") issue("signature_header", "signature_header applies to hmac-sha256 only");
    for (const field of ["objective_template", "dedupe_key"] as const) {
      const bad = badWebhookTemplateRefs(route[field] ?? "");
      if (bad.length > 0) issue(field, `only {{payload.<path>}} references are allowed, not: ${bad.join(", ")}`);
    }
  });
export type WebhookRoute = z.infer<typeof WebhookRouteSchema>;

export const WebhooksConfigSchema = z
  .object({
    /** The listener's address. Loopback by default; a public endpoint belongs behind a tunnel or proxy. */
    host: z.string().trim().min(1).default("127.0.0.1"),
    port: z.number().int().min(0).max(65535).default(DEFAULT_WEBHOOK_PORT),
    routes: z.array(WebhookRouteSchema).default([]),
  })
  .superRefine((block, ctx) => {
    const seen = { name: new Set<string>(), path: new Set<string>() };
    block.routes.forEach((route, index) => {
      for (const key of ["name", "path"] as const) {
        if (seen[key].has(route[key])) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["routes", index, key], message: `duplicate route ${key} ${route[key]}` });
        seen[key].add(route[key]);
      }
      if (route.signature === "none-localhost-only" && !LOOPBACK_HOSTS.includes(block.host)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["routes", index, "signature"], message: `none-localhost-only needs a loopback host, not ${block.host}` });
      }
    });
  });
export type WebhooksConfig = z.infer<typeof WebhooksConfigSchema>;
// [H3] end webhook routes

export const GatewayConfigSchema = z.object({
  enabled: z.boolean().default(false),
  platforms: z.array(z.string()).default([]),
  routes: z.record(z.string(), z.string()).default({}), // platform -> agentId
  /** What a second message on a busy chat does: queue it, interrupt the running turn, or refuse it. */
  double_text_policy: z.enum(["enqueue", "interrupt", "reject"]).default("enqueue"),
  /** Who receives approval cards and heartbeat messages: a platform id and a channel on it. */
  owner: z.object({ platform: z.string(), channelId: z.string() }).optional(),
  /** Push alerts to `owner`: how long a gate may wait unanswered before one reminder is sent. */
  alerts: z.object({ approval_wait_minutes: z.number().int().positive().default(30) }).default({}),
  // [P1-A] email auth
  /**
   * Inbound email is dropped before pairing and routing unless the receiving server's
   * Authentication-Results authenticates the From domain (DMARC pass, or an aligned SPF or DKIM
   * pass). `false` restores the old behaviour, for a server that strips or never writes the header.
   * `authserv_id` names that server (RFC 8601 section 2.2): only its own header is read, any other
   * is the sender's. Unset, the topmost header is read.
   */
  email: z.object({
    require_authenticated_from: z.boolean().default(true),
    authserv_id: z.string().trim().min(1).optional(),
  }).default({}),
  // [P2-3] voice notes
  /**
   * An inbound voice note (Telegram, WhatsApp, Signal, Discord, Slack) from a paired sender is
   * downloaded into `<profile>/inbox/<platform>/` and transcribed locally before the run, which
   * sees `[voice note, <n>s] <transcript>` (`gateway/voice-notes.ts`). A note longer than
   * `max_seconds`, or a download past `max_bytes`, is refused with a reply naming the cap.
   * Optional so a profile without the block (and `DEFAULT_CONFIG`) gets these defaults.
   */
  voice_notes: z.object({
    enabled: z.boolean().default(true),
    max_seconds: z.number().int().positive().default(300),
    max_bytes: z.number().int().positive().default(20 * 1024 * 1024),
  }).optional(),
  // [H3] webhook routes: optional, so a profile without the block (and `DEFAULT_CONFIG`) is unchanged.
  webhooks: WebhooksConfigSchema.optional(),
});
