/**
 * [C15] The default solo system prompt, rendered over the REAL default tool build and measured.
 *
 * "Default" is what a fresh profile's solo session is told before its own memory: the default persona,
 * the solo rules, the tool protocol, and the disclosure of every adapter the default `toolsets`
 * build plus the fleet-memory hook's three (`memory`, `fleet_search`, `brain_read`), as
 * `tools/tool-names.test.ts` builds them. The stable tier is the profile's own content, so it is left
 * empty here (the session log records what a fresh profile's adds). The council's bar (C15): no
 * "seat", no "founder", under 6,000 tokens by the gateway's own estimate (chars / 4).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { TrentConfigSchema } from "../config/schema.js";
import { createFleetSearchAdapter } from "../fleet-memory/search.js";
import type { FleetMemorySource } from "../fleet-memory/source.js";
import { CHARS_PER_TOKEN } from "../fleet-memory/tiers.js";
import { buildTrentTools, type TrentToolAdapter } from "../tools/index.js";
import { createBrainReadAdapter } from "../tools/memory/brain-read.js";
import { createMemoryAdapter } from "../tools/memory/index.js";
import { DEFAULT_SOLO_PERSONA, SOLO_RULES, SOLO_TOOL_PROTOCOL, buildSystemPrompt, soloPlatformHint } from "./prompt.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "trent-c15-prompt-"));
const built: TrentToolAdapter[] = [];
afterAll(async () => {
  await Promise.all(built.map((adapter) => adapter.cleanup()));
  fs.rmSync(root, { recursive: true, force: true });
});

/** The default build, as a fresh profile's solo runner gets it (the runtime adds the hook's adapters after the chain). */
function defaultAdapters(): TrentToolAdapter[] {
  if (built.length > 0) return built;
  const caCertPath = path.join(root, "ca.pem");
  fs.writeFileSync(caCertPath, "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n");
  const profileDir = path.join(root, "profile");
  const { toolsets } = TrentConfigSchema.parse({});
  const { adapters, skipped } = buildTrentTools(
    { toolsets, disabled_toolsets: [] },
    { workspace: root, profileDir, backend: "local", egress: { proxyUrl: "http://127.0.0.1:1", token: "tok", caCertPath } },
  );
  expect(skipped).toEqual([]);
  built.push(...adapters, createMemoryAdapter({ profileDir }), createFleetSearchAdapter({ source: {} as FleetMemorySource }), createBrainReadAdapter({ profileDir }));
  return built;
}

const defaultPrompt = (platform?: string): string =>
  buildSystemPrompt({ persona: DEFAULT_SOLO_PERSONA, stable: "", adapters: defaultAdapters(), ...(platform === undefined ? {} : { platform }) });

const occurrences = (text: string, word: string): number => (text.match(new RegExp(word, "gi")) ?? []).length;

describe("[C15] the default solo system prompt, measured", () => {
  it('names no "seat" and no "founder", and estimates under 6,000 tokens', () => {
    const text = defaultPrompt();
    const tokens = Math.ceil(text.length / CHARS_PER_TOKEN);
    console.log(`[C15] default solo system prompt: ${String(text.length)} chars, ~${String(tokens)} tokens (chars/${String(CHARS_PER_TOKEN)}), ${String(defaultAdapters().length)} adapters`);

    expect({ seat: occurrences(text, "seat"), founder: occurrences(text, "founder") }).toEqual({ seat: 0, founder: 0 });
    expect(tokens).toBeLessThan(6_000);
    // No fleet facts: nothing is consolidated at night in solo, and the memory tool is the agent's own.
    expect(text).not.toMatch(/nightly|consolidation|heartbeat/i);
  });

  it("puts the rules right after the persona, then the protocol and the tools, in that order", () => {
    const text = defaultPrompt();
    const order = [DEFAULT_SOLO_PERSONA, SOLO_RULES, SOLO_TOOL_PROTOCOL, "## Tools", "### memory"].map((part) => text.indexOf(part));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((x, y) => x - y)).toEqual(order);
  });

  it("has a section for each rule: tool use, no fabrication, several calls, what to save, skills", () => {
    for (const heading of ["## Using tools", "## No made-up facts", "## Several calls in one reply", "## What to save to memory", "## Following a skill"]) {
      expect(SOLO_RULES).toContain(heading);
    }
    // Tool-use enforcement: act rather than guess, and never claim a call that did not happen.
    expect(SOLO_RULES).toMatch(/instead of guessing/);
    expect(SOLO_RULES).toMatch(/Never say a tool ran/);
    // The runner runs a reply's calls one by one (`turn.ts`): the prompt says so and promises nothing else.
    expect(SOLO_RULES).toMatch(/one after another/);
    expect(SOLO_RULES).not.toMatch(/concurrent|in parallel/i);
    // When to save: durable facts, corrections replace, and never a secret.
    expect(SOLO_RULES).toMatch(/replace the old entry/);
    expect(SOLO_RULES).toMatch(/never save a secret/i);
    expect(SOLO_RULES).toContain("skill_view");
  });

  it("shows the memory tool's solo text: add, replace and remove, and none of the fleet's", () => {
    const memory = defaultPrompt().slice(defaultPrompt().indexOf("### memory"));
    expect(memory).toContain('"replace"');
    expect(memory).toContain('"remove"');
    expect(memory).toContain("old_text");
    expect(memory).not.toContain("Adding is the only write");
  });
});

describe("[C15] the platform hint slot", () => {
  it("the platform a gateway thread is on becomes the prefix's last section", () => {
    const text = defaultPrompt("telegram");
    expect(soloPlatformHint("telegram")).toContain("You are talking over Telegram; keep replies short, no Markdown tables");
    expect(text.endsWith(`## Where you are talking\n${soloPlatformHint("telegram")}`)).toBe(true);
    // Everything before the slot is the platform-free prefix, byte for byte.
    expect(text.startsWith(defaultPrompt())).toBe(true);
  });

  it("no platform, no section; an unknown platform is named as given", () => {
    expect(defaultPrompt()).not.toContain("## Where you are talking");
    expect(soloPlatformHint("zulip")).toMatch(/^You are talking over zulip; /);
    expect(soloPlatformHint("email")).toMatch(/no Markdown/);
  });
});
