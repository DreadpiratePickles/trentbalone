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
 * The last case measures the layout seats actually get. Until P2-7 the fleet-memory hook appended
 * all three tiers to `dynamicPrompt`, which `apps/web/lib/model-gateway.ts` `buildSeatUserPrompt`
 * renders after Company/Seat/Objective, so two objectives shared no stable prefix (0 cached, 2026-09-25).
 * The hook now puts the STABLE tier at the head of the system message (`fleet-memory/tiers.ts`
 * `placeTiers`). The case renders both prompts with the REAL hook and the app's REAL
 * `executeSeatModel` (its provider seam records the messages), sends exactly those messages, and
 * asserts the second objective's call is served cached tokens, trying up to three fresh pairs.
 *
 * Models. The PROOF runs on a model that implicitly caches: `gemini-3.6-flash`, or whatever
 * `TRENT_CACHE_PROOF_MODEL` names. The profile default (`DEFAULT_CONFIG.model`, gemini-3.5-flash-lite,
 * which Bobby chose for price) did not cache in 7 attempts on 2026-09-25, a known model limitation;
 * its case is INFORMATIONAL: it logs input, cached and cents, prints "no cache hit on <model>: ..."
 * when cached is 0, and does not fail on that, so the nightly log keeps the measurement.
 * Gated on TRENT_TEST_LIVE=1 and a key (env or <repo>/gem.env, never printed).
 * Spend: four calls of ~10.5k input tokens, plus the seat case's two to six (one to three pairs); the
 * cents are printed and recorded in the session log.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { DEFAULT_CONFIG } from "../config/defaults.js";
import { createFleetMemoryHook } from "../fleet-memory/orchestrator-hook.js";
import { InMemoryFleetSource, type FleetRun } from "../fleet-memory/source.js";
import { assembleContext, type ContextBlock } from "../fleet-memory/tiers.js";
import { createMemoryAdapter } from "../tools/memory/index.js";
import { createModelGateway } from "./index.js";
import type { GatewayCompletion, GatewayMessage } from "./types.js";

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

  it(`in the seat layout the STABLE tier heads the system message, so a second objective on the same seat is served it from cache (${PROOF_MODEL})`, async () => {
    const profileDir = mkdtempSync(path.join(tmpdir(), "trent-cache-seat-"));
    try {
      const prior: FleetRun = {
        id: "run_prior", companyId: "co_northwind", objective: "retention classes of ledger entries", status: "completed", summary: null,
        completedAt: "2026-09-24T10:00:00.000Z",
        steps: [{ id: "run_prior-s1", runId: "run_prior", agentRole: "analyst", title: "Retention classes", status: "completed", output: "Entries cycle through retention classes R0 to R6." }],
      };
      const source = new InMemoryFleetSource();
      source.addRun(prior);
      // The handbook is the workspace-context block: STABLE, and the bulk of a ~10.5k-token tier.
      const hook = createFleetMemoryHook({ source, memory: createMemoryAdapter({ profileDir }), brain: false, workspaceContext: handbook(), ceilingChars: 400_000 });
      const { executeSeatModel } = await import("@/lib/model-gateway");
      type SeatInput = Parameters<typeof executeSeatModel>[0];
      const system = "You are the analyst seat. Respond as JSON with a summary field.";
      /** One run, one analyst call, through the hook and the app; the provider is a recorder. */
      const render = async (runId: string, objective: string): Promise<GatewayMessage[]> => {
        let sent: GatewayMessage[] = [];
        const seat = hook.wrapSeatModel((input: SeatInput) =>
          executeSeatModel({
            ...input,
            createChatCompletion: async (request) => {
              sent = request.messages;
              return { choices: [{ message: { content: "{}" } }] };
            },
          }),
        );
        hook.runStarted({ runId, companyId: "co_northwind", objective, history: [{ role: "user", content: objective }] });
        const subtask = {
          id: "step_1", seat: "analyst", objective, boundaries: [], toolGuidance: [], input: {},
          contextBundle: { company: { name: "Northwind Cooperative" }, overallObjective: objective },
          classification: { type: "analyst", complexity: "standard", reversibility: "reversible" },
        } as unknown as SeatInput["subtask"];
        await seat({ companyId: "co_northwind", subtask, systemPrompt: system });
        hook.runFinished(runId);
        return sent;
      };

      // Google's implicit cache is best-effort (a first sighting of a prefix has missed on 2026-09-25),
      // so up to three FRESH pairs of objectives are tried, each logged, before the case fails.
      const pairs: ReadonlyArray<readonly [string, string]> = [
        ["Report the retention class of entry 12.", "Summarise how entry 40 is archived."],
        ["Report the retention class of entry 77.", "Summarise how entry 103 is archived."],
        ["Report the retention class of entry 150.", "Summarise how entry 201 is archived."],
      ];
      const gw = await gateway(PROOF_MODEL);
      const ask = (messages: GatewayMessage[]) => gw.complete({ role: "executor", maxTokens: 256, temperature: 0, messages });
      let stable: string | undefined;
      let cached = 0;
      let cents = 0;
      for (let pair = 1; pair <= pairs.length && cached === 0; pair += 1) {
        const [one, two] = pairs[pair - 1]!;
        const firstMessages = await render(`run_cache_${pair}a`, one);
        const secondMessages = await render(`run_cache_${pair}b`, two);
        // Layout preconditions, checked before any spend: the same stable tier heads every system message.
        stable ??= hook.stablePreludeFor(`run_cache_${pair}a`) ?? "";
        expect(hook.stablePreludeFor(`run_cache_${pair}a`)).toBe(stable);
        expect(hook.stablePreludeFor(`run_cache_${pair}b`)).toBe(stable);
        expect(firstMessages[0]?.content.startsWith(`${stable}\n\n`)).toBe(true);
        expect(secondMessages[0]?.content).toBe(firstMessages[0]?.content);

        const first = await ask(firstMessages);
        const second = await ask(secondMessages);
        cents += first.costCents + second.costCents;
        cached = second.cachedInputTokens ?? 0;
        console.log(`[prompt-cache.live] seat layout pair ${pair} ${line("call 1", first)}`);
        console.log(`[prompt-cache.live] seat layout pair ${pair} ${line("call 2", second)}`);
        console.log(`[prompt-cache.live] seat layout pair ${pair} second_call_cached=${cached}`);
        expect(first.estimated).toBe(false);
        expect(second.estimated).toBe(false);
        expect(first.inputTokens).toBeGreaterThan(4_096);
      }
      console.log(`[prompt-cache.live] seat layout stable_tier_tokens~=${Math.ceil((stable ?? "").length / 4)} total_cost_cents=${cents}`);
      expect(cached).toBeGreaterThan(0);
    } finally {
      rmSync(profileDir, { recursive: true, force: true });
    }
  }, 120_000);
});
