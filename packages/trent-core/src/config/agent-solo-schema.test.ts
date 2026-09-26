/**
 * [C11] `agent.solo.max_tool_calls`: the most tool calls one solo run may make before it stops with a
 * verdict naming the cap (`solo/turn.ts`). The `agent` block is a passthrough, so until this key had a
 * schema any value parsed and nothing read it (council C11). It is a positive whole number with a sane
 * ceiling; the other `agent.solo.*` keys (validated where they are read, `apps/cli/src/runtime/solo-continuity.ts`)
 * still pass through untouched.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "./defaults.js";
import { TrentConfigSchema } from "./schema.js";
import { SOLO_MAX_TOOL_CALLS_CEILING } from "./sections/agent.js";

const withSolo = (solo: unknown) => ({ ...DEFAULT_CONFIG, agent: { mode: "solo", solo } });

describe("[C11] agent.solo.max_tool_calls", () => {
  it("accepts a positive whole number up to the ceiling, beside the solo keys the block already holds", () => {
    const parsed = TrentConfigSchema.parse(withSolo({ max_tool_calls: 60, delegate: "off", compact_after_chars: 9000 }));
    expect(parsed.agent).toEqual({ mode: "solo", solo: { max_tool_calls: 60, delegate: "off", compact_after_chars: 9000 } });
    expect(TrentConfigSchema.parse(withSolo({ max_tool_calls: SOLO_MAX_TOOL_CALLS_CEILING })).agent).toMatchObject({ solo: { max_tool_calls: SOLO_MAX_TOOL_CALLS_CEILING } });
    expect(TrentConfigSchema.parse(withSolo({ max_tool_calls: 1 })).agent).toMatchObject({ solo: { max_tool_calls: 1 } });
  });

  it("has a ceiling a typo cannot pass: several hundred calls, not thousands", () => {
    expect(SOLO_MAX_TOOL_CALLS_CEILING).toBeGreaterThanOrEqual(100);
    expect(SOLO_MAX_TOOL_CALLS_CEILING).toBeLessThanOrEqual(1000);
  });

  it("refuses zero, a negative, a fraction, a string and a value over the ceiling, naming the key", () => {
    for (const bad of [0, -1, 2.5, "60", SOLO_MAX_TOOL_CALLS_CEILING + 1]) {
      const result = TrentConfigSchema.safeParse(withSolo({ max_tool_calls: bad }));
      expect(result.success, `max_tool_calls: ${JSON.stringify(bad)}`).toBe(false);
      if (!result.success) expect(result.error.issues.map((issue) => issue.path.join("."))).toContain("agent.solo.max_tool_calls");
    }
  });

  it("is optional and has no schema default: a profile without it parses without it", () => {
    expect(TrentConfigSchema.parse(withSolo({ delegate: "solo" })).agent).toEqual({ mode: "solo", solo: { delegate: "solo" } });
    expect(TrentConfigSchema.parse({ ...DEFAULT_CONFIG, agent: { mode: "solo" } }).agent).toEqual({ mode: "solo" });
  });
});
