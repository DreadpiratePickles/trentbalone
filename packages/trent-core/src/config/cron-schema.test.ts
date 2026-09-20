/**
 * [X4] the `cron` block: the incident threshold and the quota hold the runner reads, with the
 * documented defaults, and the runner's own constants equal to them.
 */
import { describe, expect, it } from "vitest";
import { TrentConfigSchema } from "./schema.js";
import { DEFAULT_CONFIG } from "./defaults.js";
import { DEFAULT_FAILURE_ALERT_AFTER, DEFAULT_QUOTA_HOLD_MINUTES } from "../cron/incidents.js";
import { CRON_CONFIG_DEFAULTS } from "../cron/config-schema.js";

describe("[X4] cron config block", () => {
  it("defaults to three failures before the one alert and a thirty-minute hold", () => {
    expect(TrentConfigSchema.parse({}).cron).toEqual({ failure_alert_after: 3, quota_hold_minutes: 30 });
    expect(DEFAULT_CONFIG.cron).toEqual(CRON_CONFIG_DEFAULTS);
    expect(CRON_CONFIG_DEFAULTS).toEqual({ failure_alert_after: DEFAULT_FAILURE_ALERT_AFTER, quota_hold_minutes: DEFAULT_QUOTA_HOLD_MINUTES });
  });

  it("accepts positive integers only", () => {
    expect(TrentConfigSchema.parse({ cron: { failure_alert_after: 1, quota_hold_minutes: 5 } }).cron).toEqual({ failure_alert_after: 1, quota_hold_minutes: 5 });
    expect(TrentConfigSchema.safeParse({ cron: { failure_alert_after: 0 } }).success).toBe(false);
    expect(TrentConfigSchema.safeParse({ cron: { quota_hold_minutes: 2.5 } }).success).toBe(false);
    expect(TrentConfigSchema.safeParse({ cron: { unknown: true } }).success).toBe(false);
  });
});
