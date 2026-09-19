/**
 * E1 item 4 — the `checkpoints` config block.
 *
 * Two numbers with consequences: `enabled` decides whether a write can be undone at all, and
 * `max_bytes_per_run` is the point past which a row keeps hashes and drops the bytes — so the
 * module's own constant and the config default have to be the same number, or the documented
 * ceiling and the enforced one drift apart.
 */
import { describe, expect, it } from "vitest";

import { DEFAULT_CONFIG } from "../config/defaults.js";
import { TrentConfigSchema } from "../config/schema.js";
import { DEFAULT_MAX_BYTES_PER_RUN } from "./index.js";

describe("[E1] checkpoints config block", () => {
  it("parses with the documented defaults when nothing is configured", () => {
    const parsed = TrentConfigSchema.parse({});
    expect(parsed.checkpoints.enabled).toBe(true);
    expect(parsed.checkpoints.max_bytes_per_run).toBe(50 * 1024 * 1024);
  });

  it("ships the same defaults in DEFAULT_CONFIG and in the ledger's own constant", () => {
    expect(DEFAULT_CONFIG.checkpoints.enabled).toBe(true);
    expect(DEFAULT_CONFIG.checkpoints.max_bytes_per_run).toBe(DEFAULT_MAX_BYTES_PER_RUN);
  });

  it("keeps an override and refuses a byte budget that is not a positive integer", () => {
    const parsed = TrentConfigSchema.parse({ checkpoints: { enabled: false, max_bytes_per_run: 1024 } });
    expect(parsed.checkpoints.enabled).toBe(false);
    expect(parsed.checkpoints.max_bytes_per_run).toBe(1024);
    expect(TrentConfigSchema.safeParse({ checkpoints: { max_bytes_per_run: 0 } }).success).toBe(false);
    expect(TrentConfigSchema.safeParse({ checkpoints: { max_bytes_per_run: 1.5 } }).success).toBe(false);
    expect(TrentConfigSchema.safeParse({ checkpoints: { retention_days: 7 } }).success).toBe(false);
  });
});
