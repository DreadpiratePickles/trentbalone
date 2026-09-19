/**
 * The `heartbeat` block of `TrentConfigSchema`. Composed in `config/schema.ts`, which re-exports
 * every name here.
 */

import { z } from "zod";

/**
 * The heartbeat: a model turn over `<profile>/HEARTBEAT.md` every `interval_minutes`, skipped
 * inside quiet hours (outside `active_hours`, read on the wall clock of `tz`), with the reply
 * delivered to `gateway.owner` unless it is exactly `NO_REPLY`.
 */
export const HeartbeatConfigSchema = z.object({
  enabled: z.boolean().default(false),
  interval_minutes: z.number().int().positive().default(60),
  active_hours: z.object({ start: z.string(), end: z.string(), tz: z.string().default("UTC") }).optional(),
  consolidate_memory: z.boolean().default(true),
  // [D2] heartbeat sweep
  /**
   * The unattended improvement sweep (docs/heartbeat.md, "Unattended sweeps"). `sweep.enabled` is
   * opt-in and false by default, so a profile that already runs a heartbeat keeps ticking exactly
   * as it did. With it on, a tick runs at most one sweep every `sweep_interval_hours`, never
   * inside quiet hours, and only while the day's ledger still holds `improve.sweep_cap_cents` of
   * headroom under `budget.daily_cap`; the sweep itself is handed that cap as its hard limit.
   * Nothing is promoted by any of it: drafts land in quarantine and `trent improve promote`
   * remains the human gate.
   *
   * This block belongs to `heartbeat` and therefore sits inside `HeartbeatConfigSchema`: the
   * `personality:` line is a key of `TrentConfigSchema`, where a second `heartbeat:` key would be
   * a duplicate property.
   */
  sweep: z.object({ enabled: z.boolean().default(false) }).default({}),
  sweep_interval_hours: z.number().int().positive().default(24),
  // [/D2]
});
export type HeartbeatConfig = z.infer<typeof HeartbeatConfigSchema>;
