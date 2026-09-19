/**
 * The three-tier contract for everything the wrapper injects into a seat prompt.
 *
 * STABLE is the part a provider could cache: it must not depend on the objective, the seat or the
 * turn. CONTEXT is what this objective and this seat need. VOLATILE is what changes every turn.
 * The order is stable, context, volatile — and the ceiling is enforced by trimming the two
 * trimmable tiers oldest-first, never the stable one.
 */

import { describe, expect, it } from "vitest";
import {
  CHARS_PER_TOKEN,
  DEFAULT_CONTEXT_CEILING_CHARS,
  PRESSURE_WARNING_RATIO,
  WORKSPACE_CONTEXT_BLOCK,
  assembleContext,
  estimateTokens,
  type ContextBlock,
} from "./tiers.js";

const block = (tier: ContextBlock["tier"], name: string, text: string): ContextBlock => ({ tier, name, text });

describe("three-tier context assembly", () => {
  it("renders stable, then context, then volatile, whatever order the blocks arrive in", () => {
    const assembled = assembleContext(
      [
        block("volatile", "conversation", "user: hello"),
        block("stable", "company-memory", "MEMORY.md: the company ships on Fridays."),
        block("context", "fleet-recall", "analyst: churn is a second-user problem"),
      ],
      { ceilingChars: DEFAULT_CONTEXT_CEILING_CHARS },
    );
    const text = assembled.text;
    expect(text.indexOf("MEMORY.md")).toBeLessThan(text.indexOf("churn"));
    expect(text.indexOf("churn")).toBeLessThan(text.indexOf("user: hello"));
    expect(assembled.kept.map((b) => b.name)).toEqual(["company-memory", "fleet-recall", "conversation"]);
  });

  it("measures every tier and estimates tokens at four characters each", () => {
    const assembled = assembleContext(
      [block("stable", "company-memory", "a".repeat(400)), block("context", "fleet-recall", "b".repeat(200)), block("volatile", "conversation", "c".repeat(100))],
      { ceilingChars: DEFAULT_CONTEXT_CEILING_CHARS },
    );
    expect(assembled.stableChars).toBe(400);
    expect(assembled.contextChars).toBe(200);
    expect(assembled.volatileChars).toBe(100);
    expect(assembled.chars).toBe(assembled.text.length);
    expect(assembled.estimatedTokens).toBe(Math.ceil(assembled.chars / CHARS_PER_TOKEN));
    expect(estimateTokens(400)).toBe(100);
  });

  it("trims context and volatile oldest-first and never the stable tier", () => {
    const assembled = assembleContext(
      [
        block("stable", "company-memory", "S".repeat(300)),
        block("context", "fleet-recall", "R".repeat(300)),
        block("volatile", "conversation", "C".repeat(300)),
        block("volatile", "personality", "P".repeat(50)),
      ],
      { ceilingChars: 700 },
    );
    expect(assembled.text).toContain("S".repeat(300));
    expect(assembled.dropped).toEqual(["fleet-recall"]);
    expect(assembled.chars).toBeLessThanOrEqual(700);
    expect(assembled.kept.map((b) => b.name)).toEqual(["company-memory", "conversation", "personality"]);
  });

  it("keeps the stable tier even when it alone is over the ceiling, and says so", () => {
    const assembled = assembleContext(
      [block("stable", "company-memory", "S".repeat(900)), block("context", "fleet-recall", "R".repeat(300))],
      { ceilingChars: 500 },
    );
    expect(assembled.text).toContain("S".repeat(900));
    expect(assembled.dropped).toEqual(["fleet-recall"]);
    expect(assembled.overCeiling).toBe(true);
  });

  it("reports pressure against the ceiling so a surface can warn once", () => {
    const under = assembleContext([block("stable", "company-memory", "S".repeat(100))], { ceilingChars: 1000 });
    expect(under.pressure).toBeCloseTo(0.1, 5);
    expect(under.pressure < PRESSURE_WARNING_RATIO).toBe(true);
    const over = assembleContext([block("stable", "company-memory", "S".repeat(850))], { ceilingChars: 1000 });
    expect(over.pressure >= PRESSURE_WARNING_RATIO).toBe(true);
  });

  it("drops empty blocks entirely rather than emitting blank separators", () => {
    const assembled = assembleContext(
      [block("stable", "company-memory", "S"), block("context", "fleet-recall", "   "), block("volatile", "conversation", "")],
      { ceilingChars: 1000 },
    );
    expect(assembled.text).toBe("S");
    expect(assembled.kept.map((b) => b.name)).toEqual(["company-memory"]);
    expect(assembled.dropped).toEqual([]);
  });

  it("names the workspace-context seam so the stable tier has one place for it", () => {
    expect(WORKSPACE_CONTEXT_BLOCK).toBe("workspace-context");
  });
});
