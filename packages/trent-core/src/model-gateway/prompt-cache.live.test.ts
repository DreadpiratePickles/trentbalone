/**
 * [P1-C] LIVE: does the three-tier prompt's STABLE prefix actually get served from Google's cache?
 *
 * The tier design (`fleet-memory/tiers.ts`) exists so that "a provider that caches a prefix can
 * cache this one". Until this suite nothing measured it: the gateway never read
 * `prompt_tokens_details.cached_tokens`. Two consecutive calls share an identical STABLE tier
 * (assembled by the real `assembleContext`, well over Google's 4,096-token implicit-cache minimum
 * for Flash models, https://ai.google.dev/gemini-api/docs/caching) and differ only in the CONTEXT
 * and VOLATILE tiers. The second call must report cached input tokens.
 *
 * The last case measures the layout seats actually get: `apps/web/lib/model-gateway.ts`
 * `buildSeatUserPrompt` renders Company/Seat/Objective/... BEFORE `dynamicPrompt`, which is where
 * the fleet-memory hook appends the tiers, so across two objectives the STABLE tier is not a
 * provider-visible prefix. It prints the numbers and asserts that finding; if Google ever serves
 * that tier from cache in the seat layout the assertion fails and the finding is stale.
 *
 * Models. The PROOF runs on a model that implicitly caches: `gemini-3.6-flash`, or whatever
 * `TRENT_CACHE_PROOF_MODEL` names. The profile default (`DEFAULT_CONFIG.model`, gemini-3.5-flash-lite,
 * which Bobby chose for price) did not cache in 7 attempts on 2026-09-25, a known model limitation;
 * its case is INFORMATIONAL: it logs input, cached and cents, prints "no cache hit on <model>: ..."
 * when cached is 0, and does not fail on that, so the nightly log keeps the measurement.
 * Gated on TRENT_TEST_LIVE=1 and a key (env or <repo>/gem.env, never printed).
 * Spend: six calls of ~10.5k input tokens; the cents are printed and recorded in the session log.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { DEFAULT_CONFIG } from "../config/defaults.js";
import { assembleContext, type ContextBlock } from "../fleet-memory/tiers.js";
import { createModelGateway } from "./index.js";
import type { GatewayCompletion } from "./types.js";

const REPO_ROOT = path.resolve(__dirname, "../../../..");

function readGeminiKey(): string | undefined {
  const fromEnv = process.env.GEMINI_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  try {
    for (const line of readFileSync(path.join(REPO_ROOT, "gem.env"), "utf8").split(/\r?\n/)) {
      const match = /^\s*(?:export\s+)?GEMINI_API_KEY\s*=\s*(.*)$/.exec(line);
      const value = match?.[1]?.trim().replace(/^["']|["']$/g, "");
      if (value) return value;
    }
  } catch {
    /* no file: skipped below */
  }
  return undefined;
}

const KEY = readGeminiKey();
const LIVE = process.env.TRENT_TEST_LIVE === "1" && KEY !== undefined;
if (!LIVE) console.error("[prompt-cache.live] SKIPPED: needs TRENT_TEST_LIVE=1 and GEMINI_API_KEY (env or <repo>/gem.env). A skip is NOT a pass.");

/** A model that implicitly caches (8,164 of 10,543 cached on 2026-09-25). */
const PROOF_MODEL = process.env.TRENT_CACHE_PROOF_MODEL?.trim() || "gemini-3.6-flash";
const DEFAULT_MODEL = DEFAULT_CONFIG.model;

/** A deterministic company handbook: the STABLE tier's bulk, identical bytes on every call. */
function handbook(): string {
  const lines: string[] = ["# Company memory: Northwind Cooperative operating handbook"];
  for (let clause = 1; clause <= 260; clause += 1) {
    lines.push(
      `Clause ${clause}. Shipment ledger entry ${clause} is reconciled against the dock manifest, countersigned by ` +
        `the shift lead on duty, and archived for seven years under retention class R${clause % 7}.`,
    );
  }
  return lines.join("\n");
}

const STABLE: ContextBlock[] = [
  { tier: "stable", name: "company-memory", text: handbook() },
  { tier: "stable", name: "workspace-context", text: "# Workspace\nAGENTS.md: answer in one short line; never guess a clause." },
  { tier: "stable", name: "shared-skills-org", text: "# Shared skills (org)\n- ledger-lookup: find a clause by entry number" },
];

function tiered(recall: string, turn: string): string {
  const blocks: ContextBlock[] = [
    ...STABLE,
    { tier: "context", name: "fleet-recall", text: `# Recall\n${recall}` },
    { tier: "volatile", name: "conversation", text: `# Conversation\nuser: ${turn}` },
  ];
  return assembleContext(blocks, { ceilingChars: 400_000 }).text;
}

async function gateway(model: string) {
  return createModelGateway({ apiKeys: { google: KEY! }, preferredProvider: "google", allowedProviders: ["google"], models: { executor: model } });
}

/** Two calls whose prompts share the system line and the STABLE tier, and differ after it. */
async function twoCallsSharingTheStableTier(model: string): Promise<[GatewayCompletion, GatewayCompletion]> {
  const gw = await gateway(model);
  const system = "You are the analyst seat of a small company. Answer from the memory below.";
  const ask = async (recall: string, turn: string) =>
    gw.complete({ role: "executor", maxTokens: 256, temperature: 0, messages: [{ role: "system", content: system }, { role: "user", content: tiered(recall, turn) }] });
  const first = await ask("analyst looked up entry 12 yesterday", "Which retention class applies to entry 12? One word.");
  const second = await ask("analyst looked up entry 40 last week", "Which retention class applies to entry 40? One word.");
  return [first, second];
}

function line(label: string, call: GatewayCompletion): string {
  return `${label}: model=${call.model} input=${call.inputTokens} cached=${call.cachedInputTokens ?? 0} output=${call.outputTokens} cost_cents=${call.costCents} estimated=${call.estimated}`;
}

describe.skipIf(!LIVE)("prompt cache (live, google) [P1-C]", () => {
  it(`the second of two calls sharing the STABLE tier as a prefix reports cached input tokens (${PROOF_MODEL})`, async () => {
    const [first, second] = await twoCallsSharingTheStableTier(PROOF_MODEL);
    console.log(`[prompt-cache.live] ${line("call 1", first)}`);
    console.log(`[prompt-cache.live] ${line("call 2", second)}`);
    console.log(`[prompt-cache.live] total_cost_cents=${first.costCents + second.costCents}`);

    expect(first.estimated).toBe(false);
    expect(second.estimated).toBe(false);
    expect(first.inputTokens).toBeGreaterThan(4_096);
    expect(second.cachedInputTokens ?? 0).toBeGreaterThan(0);
  }, 120_000);

  it(`measures the profile default (${DEFAULT_MODEL}) without failing on a cache miss (informational)`, async () => {
    const [first, second] = await twoCallsSharingTheStableTier(DEFAULT_MODEL);
    console.log(`[prompt-cache.live] default ${line("call 1", first)}`);
    console.log(`[prompt-cache.live] default ${line("call 2", second)}`);
    console.log(`[prompt-cache.live] default total_cost_cents=${first.costCents + second.costCents}`);
    const cached = second.cachedInputTokens ?? 0;
    if (cached === 0) console.log(`[prompt-cache.live] no cache hit on ${second.model}: ${second.inputTokens} input, 0 cached`);
    else console.log(`[prompt-cache.live] cache hit on ${second.model}: ${cached} of ${second.inputTokens} input cached`);
    // The measurement must be real to be worth keeping; a miss is a recorded model limitation, not a failure.
    expect(second.estimated).toBe(false);
    expect(Number.isInteger(second.costCents)).toBe(true);
  }, 120_000);

  it(`in the seat layout the objective precedes the tiers, so the STABLE tier is not served from cache (${PROOF_MODEL})`, async () => {
    const gw = await gateway(PROOF_MODEL);
    // The order of apps/web/lib/model-gateway.ts buildSeatUserPrompt: these lines, then dynamicPrompt.
    const seat = (objective: string) =>
      [
        "Company: Northwind Cooperative (id: co_northwind)",
        "Seat: analyst",
        `Objective: ${objective}`,
        "Boundaries: none",
        "Tool guidance: none",
        `Context: ${JSON.stringify({ objective })}`,
        "Input: {}",
        tiered("no recall", objective),
      ].join("\n");
    const system = "You are the analyst seat. Respond as JSON with a summary field.";
    const ask = async (objective: string) =>
      gw.complete({ role: "executor", maxTokens: 256, temperature: 0, messages: [{ role: "system", content: system }, { role: "user", content: seat(objective) }] });

    const first = await ask("Report the retention class of entry 12.");
    const second = await ask("Summarise how entry 40 is archived.");
    const stableTokens = Math.ceil(assembleContext(STABLE, { ceilingChars: 400_000 }).chars / 4);
    console.log(`[prompt-cache.live] seat layout ${line("call 1", first)}`);
    console.log(`[prompt-cache.live] seat layout ${line("call 2", second)}`);
    console.log(`[prompt-cache.live] seat layout stable_tier_tokens~=${stableTokens} total_cost_cents=${first.costCents + second.costCents}`);

    expect(second.estimated).toBe(false);
    expect(second.cachedInputTokens ?? 0).toBeLessThan(stableTokens);
  }, 120_000);
});
