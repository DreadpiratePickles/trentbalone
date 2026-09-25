/**
 * The `gateway` block of `TrentConfigSchema`. Composed in `config/schema.ts`, which re-exports
 * every name here.
 */

import { z } from "zod";

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
});
