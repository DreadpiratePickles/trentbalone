/**
 * 3.9 — the offline degraded banner.
 *
 * With no key the planner silently falls back to deterministic plans and the critic
 * auto-passes. That output must never be mistaken for real model output, so it is
 * announced before the first turn and marked on every agent line.
 */

import { describe, it, expect } from "vitest";
import { createTheme, EMBER_SGR, sgrCodesIn } from "../../ui/index.js";
import { isDegraded, renderDegradedBanner, DEGRADED_MARK } from "../degraded.js";
import { makeHarness } from "./harness.js";

const plain = createTheme("none");

describe("degraded detection", () => {
  it("is degraded when no provider key is present anywhere", () => {
    expect(isDegraded({})).toBe(true);
  });

  it("is not degraded once any provider key is configured", () => {
    for (const name of ["GEMINI_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "MISTRAL_API_KEY", "OPENROUTER_API_KEY"]) {
      expect(isDegraded({ [name]: "x" }), name).toBe(false);
    }
  });

  it("treats an empty or whitespace value as absent", () => {
    expect(isDegraded({ GEMINI_API_KEY: "" })).toBe(true);
    expect(isDegraded({ GEMINI_API_KEY: "   " })).toBe(true);
  });

  it("never echoes the key it found", () => {
    const secret = "AIzaSyExampleNotARealKeyValue";
    const banner = renderDegradedBanner(plain, 72).join("\n");
    expect(isDegraded({ GEMINI_API_KEY: secret })).toBe(false);
    expect(banner).not.toContain(secret);
  });
});

describe("the banner", () => {
  it("says plainly that plans are deterministic and the critic auto-passes", () => {
    const text = renderDegradedBanner(plain, 72).join("\n").toLowerCase();
    expect(text).toContain("degraded");
    expect(text).toContain("deterministic");
    expect(text).toContain("critic");
    expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
  });

  it("is ember, because a human needs to notice it", () => {
    const colour = createTheme("truecolor");
    expect(sgrCodesIn(renderDegradedBanner(colour, 72).join("\n"))).toContain(EMBER_SGR.truecolor);
  });

  it("fits the width it is given", () => {
    for (const width of [40, 72, 120]) {
      for (const line of renderDegradedBanner(plain, width)) {
        expect(line.length).toBeLessThanOrEqual(width);
      }
    }
  });
});

describe("the engine in degraded mode", () => {
  it("prints the banner before the first turn, exactly once", async () => {
    const h = makeHarness({ degraded: true });
    await h.engine.start();
    const banners = () => h.out.filter((line) => line.includes("DEGRADED MODE")).length;
    expect(banners()).toBe(1);
    await h.engine.submit("one");
    expect(banners()).toBe(1);
  });

  it("marks every agent line, so degraded output can never pass for real output", async () => {
    const h = makeHarness({ degraded: true });
    await h.engine.submit("one");
    const agentLines = h.transcript().filter((l) => l.includes("["));
    expect(agentLines.length).toBeGreaterThan(0);
    for (const line of agentLines) expect(line).toContain(DEGRADED_MARK);
  });

  it("prints no banner and no marks when a key is present", async () => {
    const h = makeHarness({ degraded: false });
    await h.engine.start();
    await h.engine.submit("one");
    expect(h.out.filter((l) => l.includes("DEGRADED MODE"))).toHaveLength(0);
    for (const line of h.transcript()) expect(line).not.toContain(DEGRADED_MARK);
  });
});
