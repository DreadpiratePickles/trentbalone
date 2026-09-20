/**
 * [X4] The `cron` block of `config.yaml`: what the runner's incident book reads.
 *
 * `failure_alert_after` is the number of consecutive scheduled failures of one job that opens an
 * incident and sends the one `[CRON_FAILURE]` alert to `gateway.owner`; further failures count
 * and never alert until `trent cron incidents ack <job>`. `quota_hold_minutes` is how long a
 * provider 429 holds every prompt-driven job when the provider's own `Retry-After` names no wait.
 *
 * Defined beside the book that reads it (`incidents.ts`) and composed into `config/schema.ts` by
 * one marked block, the way `gate`, `goals` and `retrieval` are.
 */
import { z } from "zod";
import { DEFAULT_FAILURE_ALERT_AFTER, DEFAULT_QUOTA_HOLD_MINUTES } from "./incidents.js";

export const CronConfigSchema = z
  .object({
    /** Consecutive scheduled failures of one job before its one alert. */
    failure_alert_after: z.number().int().positive().default(DEFAULT_FAILURE_ALERT_AFTER),
    /** Minutes a provider 429 holds prompt-driven jobs when no `Retry-After` is given. */
    quota_hold_minutes: z.number().int().positive().default(DEFAULT_QUOTA_HOLD_MINUTES),
  })
  .strict();

export type CronConfig = z.infer<typeof CronConfigSchema>;

export const CRON_CONFIG_DEFAULTS: CronConfig = { failure_alert_after: DEFAULT_FAILURE_ALERT_AFTER, quota_hold_minutes: DEFAULT_QUOTA_HOLD_MINUTES };
