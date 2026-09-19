/**
 * Live proof for C3: the configured provider's embedding endpoint really returns vectors in which
 * a paraphrase of an objective is closer to it than an unrelated sentence. That is the whole claim
 * hybrid recall rests on, and it cannot be proven with a fake embedder.
 *
 * Needs TRENT_TEST_LIVE=1 and a key (env, or GEMINI_API_KEY / OPENAI_API_KEY in <repo>/gem.env).
 * A skip is NOT a pass. Two short sentences plus one objective: three inputs, one request.
 * The key is read but never printed, and no vector or response body is logged.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { EMBEDDER_ROUTES, createEmbedder } from "./embedder.js";
import { vectorCredit } from "./hybrid.js";
import { cosineSimilarity } from "./lexical.js";

const REPO_ROOT = path.resolve(__dirname, "../../../..");
const KEY_NAMES = ["GEMINI_API_KEY", "GOOGLE_API_KEY", "OPENAI_API_KEY"] as const;

/** The same `gem.env` fallback the other live suites use. Values are never echoed. */
function keysFromRepoEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    for (const line of fs.readFileSync(path.join(REPO_ROOT, "gem.env"), "utf8").split(/\r?\n/)) {
      const match = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
      if (!match) continue;
      const value = match[2]!.trim().replace(/^["']|["']$/g, "");
      if (value) out[match[1]!] = value;
    }
  } catch {
    /* no gem.env on this machine */
  }
  return out;
}

const secrets: Record<string, string> = { ...keysFromRepoEnv() };
for (const name of KEY_NAMES) {
  const fromEnv = process.env[name]?.trim();
  if (fromEnv) secrets[name] = fromEnv;
}

const HAS_KEY = KEY_NAMES.some((name) => secrets[name] !== undefined);
const LIVE = process.env.TRENT_TEST_LIVE === "1" && HAS_KEY;
if (!LIVE) {
  console.error("[embedder.live] SKIPPED: needs TRENT_TEST_LIVE=1 and an embedding key (env or <repo>/gem.env).");
}

const OBJECTIVE = "reduce monthly churn on the annual subscription tier";
const PARAPHRASE = "stop yearly plan customers from cancelling every month";
const UNRELATED = "the warehouse forklift needs its hydraulic seals replaced before winter";

const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-embed-live-"));

describe.skipIf(!LIVE)("live embedder", () => {
  afterAll(() => {
    fs.rmSync(profileDir, { recursive: true, force: true });
  });

  it("puts a paraphrase of the objective closer than an unrelated sentence", async () => {
    const embedder = createEmbedder({}, secrets, { profileDir });
    expect(embedder.provider).not.toBe("none");

    const [objective, paraphrase, unrelated] = await embedder.embed([OBJECTIVE, PARAPHRASE, UNRELATED]);
    expect(objective!.length).toBeGreaterThan(0);

    const near = cosineSimilarity(objective!, paraphrase!);
    const far = cosineSimilarity(objective!, unrelated!);
    console.error(
      `[embedder.live] provider=${embedder.provider} model=${embedder.model} dims=${objective!.length} `
      + `cos(paraphrase)=${near.toFixed(4)} cos(unrelated)=${far.toFixed(4)}`,
    );
    expect(near).toBeGreaterThan(far);

    // The calibration the blend rests on: this model's floor must sit between the two, or an
    // unrelated candidate collects vector credit and every run recalls something.
    const floor = EMBEDDER_ROUTES[embedder.provider === "gemini" ? "gemini" : "openai"].vectorFloor;
    expect(vectorCredit(far, floor)).toBe(0);
    expect(vectorCredit(near, floor)).toBeGreaterThan(0);
  }, 60_000);
});
