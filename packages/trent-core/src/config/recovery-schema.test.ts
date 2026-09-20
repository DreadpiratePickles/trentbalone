/**
 * [X5] the `agent` block: `auto_recovery_cycles`, the re-runs a step gets after a transient
 * provider or tool error, with the documented default of one.
 */
import { describe, expect, it } from "vitest";

import { DEFAULT_AUTO_RECOVERY_CYCLES } from "../orchestrator/auto-recovery.js";
import { DEFAULT_CONFIG } from "./defaults.js";
import { TrentConfigSchema } from "./schema.js";

describe("[X5] agent config block", () => {
  it("ships auto_recovery_cycles as 1, the same number the orchestrator applies when the key is absent", () => {
    expect(DEFAULT_CONFIG.agent.auto_recovery_cycles).toBe(1);
    expect(TrentConfigSchema.parse(DEFAULT_CONFIG).agent.auto_recovery_cycles).toBe(1);
    expect(DEFAULT_AUTO_RECOVERY_CYCLES).toBe(1);
    // A profile written before the key existed parses without it; the orchestrator's default then applies.
    expect(TrentConfigSchema.parse({}).agent.auto_recovery_cycles).toBeUndefined();
  });

  it("keeps a configured count, allows 0 to turn recovery off, and refuses a negative or fractional one", () => {
    expect(TrentConfigSchema.parse({ agent: { auto_recovery_cycles: 3 } }).agent.auto_recovery_cycles).toBe(3);
    expect(TrentConfigSchema.parse({ agent: { auto_recovery_cycles: 0 } }).agent.auto_recovery_cycles).toBe(0);
    expect(TrentConfigSchema.safeParse({ agent: { auto_recovery_cycles: -1 } }).success).toBe(false);
    expect(TrentConfigSchema.safeParse({ agent: { auto_recovery_cycles: 1.5 } }).success).toBe(false);
  });

  it("passes through what the setup wizard already writes under agent", () => {
    // `setup/steps.ts` mirrors the disabled toolsets into `agent.disabled_toolsets`; a strict block would refuse every profile that ran setup.
    const parsed = TrentConfigSchema.parse({ agent: { disabled_toolsets: ["browser"] } });
    expect(parsed.agent.disabled_toolsets).toEqual(["browser"]);
  });
});
