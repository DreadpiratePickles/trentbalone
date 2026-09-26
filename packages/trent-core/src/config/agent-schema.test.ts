/**
 * [S1] `agent.mode`: which runner a surface starts, `fleet` (the planner, the seats, the critic,
 * the consolidator) or `solo` (one agent, one tool loop; `solo/runner.ts`). The `agent` block is
 * a passthrough that already holds `auto_recovery_cycles` and the setup wizard's
 * `disabled_toolsets`: the key extends it and replaces nothing.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "./defaults.js";
import { TrentConfigSchema } from "./schema.js";

const withAgent = (agent: unknown) => ({ ...DEFAULT_CONFIG, agent });

describe("[S1] agent.mode", () => {
  it("accepts fleet and solo beside the keys the block already holds", () => {
    const parsed = TrentConfigSchema.parse(withAgent({ mode: "solo", auto_recovery_cycles: 2, disabled_toolsets: ["web"] }));
    expect(parsed.agent).toEqual({ mode: "solo", auto_recovery_cycles: 2, disabled_toolsets: ["web"] });
    expect(TrentConfigSchema.parse(withAgent({ mode: "fleet" })).agent).toEqual({ mode: "fleet" });
  });

  it("refuses a mode that does not exist", () => {
    expect(TrentConfigSchema.safeParse(withAgent({ mode: "swarm" })).success).toBe(false);
  });

  it("has no schema default: a profile without the key parses without it, and reads as fleet", async () => {
    const parsed = TrentConfigSchema.parse(withAgent({ auto_recovery_cycles: 1 }));
    expect(parsed.agent).toEqual({ auto_recovery_cycles: 1 });
    const { agentMode } = await import("./sections/agent.js");
    expect(agentMode(parsed)).toBe("fleet");
    expect(agentMode(TrentConfigSchema.parse(withAgent({ mode: "solo" })))).toBe("solo");
  });
});
