/**
 * D4 RED — the `goals` block reaches the real config, and its defaults are the enforced constants
 * rather than a second copy of them that can drift.
 */

import { describe, expect, it } from "vitest";
import { TrentConfigSchema } from "../config/schema.js";
import { DEFAULT_CONFIG } from "../config/defaults.js";
import { GoalsConfigSchema } from "./config-schema.js";
import { DEFAULT_MAX_CONTINUATIONS, DEFAULT_VERIFY_COMMANDS } from "./types.js";

describe("the goals config block", () => {
  it("defaults to verify_on_stop on, auto_continue off, and the documented command list", () => {
    const parsed = GoalsConfigSchema.parse({});
    expect(parsed.verify_on_stop).toBe(true);
    expect(parsed.auto_continue).toBe(false);
    expect(parsed.max_continuations).toBe(DEFAULT_MAX_CONTINUATIONS);
    expect(parsed.verify_commands).toEqual([...DEFAULT_VERIFY_COMMANDS]);
  });

  it("is part of TrentConfigSchema, and the shipped defaults agree with the schema's", () => {
    const config = TrentConfigSchema.parse({ provider: "anthropic", model: "claude-sonnet-4-5" });
    expect(config.goals.verify_on_stop).toBe(true);
    expect(config.goals.max_continuations).toBe(DEFAULT_MAX_CONTINUATIONS);
    expect(DEFAULT_CONFIG.goals).toEqual(GoalsConfigSchema.parse({}));
  });

  it("refuses a key nobody reads, rather than accepting it silently", () => {
    expect(() => GoalsConfigSchema.parse({ verify_on_stopp: true })).toThrow();
  });
});
