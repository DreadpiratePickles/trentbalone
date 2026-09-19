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
});
