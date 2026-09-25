/**
 * [P1-C] LIVE: `reasoning_effort` reaches Google and changes what the call costs.
 *
 * One short golden prompt, once at `low` and once at `high`, on the profile default model
 * (`DEFAULT_CONFIG.model`; `TRENT_LIVE_EFFORT_MODEL` names another for a contrast run). Prints the
 * billed output tokens (thinking included: Google reports thinking only in `total_tokens`, see
 * `openai-compat.ts`), the thinking tokens and the cost in integer cents for each. Asserts both
 * answers are right, both usages are real (not the chars/4 estimate), and `high` thought more than
 * `low`, which is the proof the field reached the model.
 *
 * Gated on TRENT_TEST_LIVE=1 and a key (env or <repo>/gem.env, never printed). Two calls.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { DEFAULT_CONFIG } from "../config/defaults.js";
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
if (!LIVE) console.error("[reasoning-effort.live] SKIPPED: needs TRENT_TEST_LIVE=1 and GEMINI_API_KEY (env or <repo>/gem.env). A skip is NOT a pass.");

const MODEL = process.env.TRENT_LIVE_EFFORT_MODEL?.trim() || DEFAULT_CONFIG.model;

/** The golden: a question whose first instinct is wrong (10), so thinking has something to do. */
const GOLDEN =
  "A bat and a ball cost 110 cents in total. The bat costs 100 cents more than the ball. " +
  "How many cents does the ball cost? Reply with the number only.";

function line(effort: string, call: GatewayCompletion): string {
  return `effort=${effort} model=${call.model} input=${call.inputTokens} output=${call.outputTokens} thinking=${call.reasoningTokens ?? 0} cost_cents=${call.costCents} answer=${JSON.stringify(call.text.trim())}`;
}

describe.skipIf(!LIVE)("reasoning_effort (live, google) [P1-C]", () => {
  it("runs the golden at low and at high and reports output tokens and cents for each", async () => {
    const gateway = await createModelGateway({ apiKeys: { google: KEY! }, preferredProvider: "google", allowedProviders: ["google"], models: { executor: MODEL } });
    const run = (reasoningEffort: "low" | "high") =>
      gateway.complete({ role: "executor", reasoningEffort, maxTokens: 4096, temperature: 0, messages: [{ role: "user", content: GOLDEN }] });

    const low = await run("low");
    const high = await run("high");
    console.log(`[reasoning-effort.live] ${line("low", low)}`);
    console.log(`[reasoning-effort.live] ${line("high", high)}`);
    console.log(`[reasoning-effort.live] total_cost_cents=${low.costCents + high.costCents} output_delta=${high.outputTokens - low.outputTokens}`);

    for (const call of [low, high]) {
      expect(call.estimated).toBe(false);
      expect(Number.isInteger(call.costCents)).toBe(true);
      expect(call.text).toMatch(/\b5\b/);
    }
    expect(high.outputTokens).toBeGreaterThan(low.outputTokens);
  }, 180_000);
});
