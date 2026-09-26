/**
 * 3.9 — the offline degraded banner.
 *
 * With no key the planner silently falls back to deterministic plans and the critic
 * auto-passes. That output must never be mistaken for real model output, so it is
 * announced before the first turn and marked on every agent line.
 */

import { describe, it, expect } from "vitest";
import { createTheme, EMBER_SGR, sgrCodesIn } from "../../ui/index.js";
import { isDegraded, degradedState, renderDegradedBanner, DEGRADED_MARK } from "../degraded.js";
import { makeHarness } from "./harness.js";
import { PROVIDER_ENV_VARS } from "@trent/core/setup/index.js";
import { createLocalRuntime } from "@trent/core/setup/local-runtime.js";
import { createLocalDiscovery } from "@trent/core/setup/local-detect.js"; // [C9]
import { CHAT_CAPS, fakeLocal } from "@trent/core/setup/local-fakes.test-helpers.js"; // [C9]

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

  it("counts every key name setup detects, so a key setup accepted never leaves the REPL degraded", () => {
    for (const name of Object.values(PROVIDER_ENV_VARS).flat()) {
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

describe("the no-key paragraph", () => {
  const paragraph = (width: number): string => renderDegradedBanner(plain, width).join(" ").replace(/\s+/g, " ").trim();

  it("says no model key was found, what works without one, and ends on the one command that fixes it", () => {
    const text = paragraph(80);
    expect(text).toMatch(/no model provider key was found/i);
    for (const works of ["/help", "trent doctor", "trent config get|set", "trent fleet list", "trent brain status|log|show"]) {
      expect(text, works).toContain(works);
    }
    expect(text).toMatch(/then run: trent setup$/);
  });

  it("wraps rather than truncates: every word survives at every width", () => {
    const words = paragraph(1000);
    for (const width of [40, 72, 120]) expect(paragraph(width), String(width)).toBe(words);
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

/**
 * [L0-3] G7: DEGRADED means no usable provider, not no key.
 *
 * Under `provider: ollama` the banner used to say "no model provider key was found" on every launch,
 * though a local runtime needs none (01_discovery/output/trent-local-path-audit-2026-09-26.md, G7).
 * Now a local provider is judged by its runtime: reachable with the model pulled boots normally; down
 * says so in one line naming the URL and the start command. The runtime is a fake `fetch`.
 */
describe("[L0-3] a local provider is judged by its runtime, not by a key", () => {
  const up = (models: string[]) =>
    createLocalRuntime({
      fetch: (async (input: string | URL | Request) => {
        const url = String(input);
        if (url.endsWith("/api/version")) return Response.json({ version: "0.32.9" });
        if (url.endsWith("/api/tags")) return Response.json({ models: models.map((name) => ({ name })) });
        if (url.endsWith("/v1/models")) return Response.json({ data: models.map((id) => ({ id })) });
        return new Response("not found", { status: 404 });
      }) as typeof fetch,
    });
  const down = createLocalRuntime({
    fetch: (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch,
  });

  it("isDegraded is false for a keyless local provider with no key anywhere", () => {
    expect(isDegraded({}, "ollama")).toBe(false);
    expect(isDegraded({}, "lmstudio")).toBe(false);
    expect(isDegraded({}, "openai")).toBe(true);
    expect(isDegraded({})).toBe(true);
  });

  it("reachable runtime and a pulled model: not degraded, no notice", async () => {
    const state = await degradedState({ source: {}, provider: "ollama", model: "qwen3.5:9b", env: {}, runtime: up(["qwen3.5:9b"]) });
    expect(state).toEqual({ degraded: false });
  });

  it("runtime down: degraded, with one line naming the URL and `ollama serve`", async () => {
    const state = await degradedState({ source: {}, provider: "ollama", model: "qwen3.5:9b", env: {}, runtime: down });
    expect(state.degraded).toBe(true);
    expect(state.notice).toContain("http://127.0.0.1:11434");
    expect(state.notice).toContain("ollama serve");
    expect(state.notice).not.toContain("\n");
    // One line at the width a piped or default terminal gets (80 columns), not merely at 120.
    expect(renderDegradedBanner(plain, 80, state.notice)).toHaveLength(1);
  });

  it("names the endpoint OLLAMA_BASE_URL points at, and LM Studio's own start command", async () => {
    const moved = await degradedState({ source: {}, provider: "ollama", model: "m", env: { OLLAMA_BASE_URL: "http://10.0.0.5:11434/v1" }, runtime: down });
    expect(moved.notice).toContain("http://10.0.0.5:11434");
    const lm = await degradedState({ source: {}, provider: "lmstudio", model: "m", env: {}, runtime: down });
    expect(lm.notice).toContain("http://127.0.0.1:1234");
    expect(lm.notice).toContain("lms server start");
  });

  it("runtime up but the model not pulled: degraded, and the line is the pull command", async () => {
    const state = await degradedState({ source: {}, provider: "ollama", model: "qwen3.6:27b", env: {}, runtime: up(["qwen3.5:9b"]) });
    expect(state.degraded).toBe(true);
    expect(state.notice).toContain("ollama pull qwen3.6:27b");
  });

  it("a hosted provider keeps the key rule and never probes a runtime", async () => {
    let probed = false;
    const spy = createLocalRuntime({ fetch: (async () => ((probed = true), Response.json({}))) as typeof fetch });
    const nothingLocal = createLocalDiscovery({ fetch: fakeLocal({}).fetch }); // [C9] no local runtime answers
    expect(await degradedState({ source: {}, provider: "openai", model: "gpt-x", env: {}, runtime: spy, discovery: nothingLocal })).toEqual({ degraded: true }); // [C9]
    expect(await degradedState({ source: { OPENAI_API_KEY: "x" }, provider: "openai", model: "gpt-x", env: {}, runtime: spy })).toEqual({ degraded: false });
    expect(probed).toBe(false);
  });

  // [C9] No key, but a model on this machine needs none: the banner names the local setup first.
  it("[C9] a keyless hosted profile with a usable local runtime: the banner names trent setup --mode local", async () => {
    const ollama = fakeLocal({ ollama: { models: [{ name: "qwen3.5:9b", capabilities: [...CHAT_CAPS] }] } });
    const state = await degradedState({ source: {}, provider: "openai", model: "gpt-x", env: {}, discovery: createLocalDiscovery({ fetch: ollama.fetch }) });
    expect(state.degraded).toBe(true);
    const text = renderDegradedBanner(plain, 80, state.notice).join(" ").replace(/\s+/g, " ");
    expect(text).toContain("DEGRADED MODE");
    expect(text).toContain("Ollama at http://127.0.0.1:11434 has qwen3.5:9b");
    expect(text).toContain("trent setup --mode local");
    expect(text.indexOf("trent setup --mode local")).toBeLessThan(text.indexOf("OPENAI_API_KEY"));
    for (const line of renderDegradedBanner(plain, 80, state.notice)) expect(line.length).toBeLessThanOrEqual(80);
    // With a key there is nothing to suggest and nothing is probed.
    const calls = ollama.calls.length;
    expect(await degradedState({ source: { OPENAI_API_KEY: "x" }, provider: "openai", env: {}, discovery: createLocalDiscovery({ fetch: ollama.fetch }) })).toEqual({ degraded: false });
    expect(ollama.calls).toHaveLength(calls);
  });

  it("the engine prints the one-line notice instead of the no-key paragraph, and still marks agent lines", async () => {
    const notice = "DEGRADED MODE: Ollama is not answering at http://127.0.0.1:11434; start it with: ollama serve";
    const h = makeHarness({ degraded: true, degradedNotice: notice });
    await h.engine.start();
    expect(h.out.filter((line) => line.includes("ollama serve"))).toHaveLength(1);
    expect(h.out.join("\n")).not.toMatch(/no model provider key was found/);
    await h.engine.submit("one");
    for (const line of h.transcript().filter((l) => l.includes("["))) expect(line).toContain(DEGRADED_MARK);
  });
});
