/**
 * Live proof for C3: the configured provider's embedding endpoint really returns vectors in which
 * a paraphrase of an objective is closer to it than an unrelated sentence. That is the whole claim
 * hybrid recall rests on, and it cannot be proven with a fake embedder.
 *
 * Needs TRENT_TEST_LIVE=1 and a key (env, or GEMINI_API_KEY / OPENAI_API_KEY in <repo>/gem.env).
 * A skip is NOT a pass. Two short sentences plus one objective: three inputs, one request.
 * The key is read but never printed, and no vector or response body is logged.
 *
 * [L0-5] `TRENT_EMBEDDER_LIVE_LOCAL=ollama|lmstudio|llamacpp` (with TRENT_TEST_LIVE=1) runs the LOCAL
 * calibration instead, and nothing else: no key is read, `gem.env` is not opened, no hosted suite runs.
 * `TRENT_EMBEDDER_LIVE_MODEL` names the model (default: the runtime's). It prints each triple's cosines
 * in both spaces and the rule's floors, which is how `RECORDED_LOCAL_FLOORS` is set, and asserts the
 * recorded floors get all three triples right.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { EMBEDDER_ROUTES, createEmbedder } from "./embedder.js";
import { RECORDED_LOCAL_FLOORS, calibrationSanity, floorFromPairs, measureCalibration } from "./embedder-calibration.js";
import { isLocalEmbedderProvider, normaliseLocalModel } from "./embedder-local.js";
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

/** [L0-5] The local runtime under calibration, when one is named; then no key is read at all. */
const LOCAL_RAW = process.env.TRENT_EMBEDDER_LIVE_LOCAL?.trim().toLowerCase();
const LOCAL = isLocalEmbedderProvider(LOCAL_RAW) ? LOCAL_RAW : undefined;

const secrets: Record<string, string> = LOCAL === undefined ? { ...keysFromRepoEnv() } : {};
for (const name of LOCAL === undefined ? KEY_NAMES : []) {
  const fromEnv = process.env[name]?.trim();
  if (fromEnv) secrets[name] = fromEnv;
}

const HAS_KEY = KEY_NAMES.some((name) => secrets[name] !== undefined);
const LIVE = process.env.TRENT_TEST_LIVE === "1" && HAS_KEY && LOCAL === undefined;
if (!LIVE && LOCAL === undefined) {
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

  // [P2-13] The same three sentences with asymmetric task types: the objective as a RETRIEVAL_QUERY,
  // the two candidates as RETRIEVAL_DOCUMENTs, which is how brain recall now embeds. The task-typed
  // floor (`queryFloor`) is set from these two figures by the rule that gave the symmetric one:
  // unrelated + 0.3 x (paraphrase - unrelated), to two places (symmetric: 0.529 + 0.3 x 0.225 = 0.60).
  it.skipIf(secrets.GEMINI_API_KEY === undefined && secrets.GOOGLE_API_KEY === undefined)("with task types, the paraphrase still beats the unrelated sentence and the task-typed floor sits between them", async () => {
    const embedder = createEmbedder({ provider: "google" }, secrets, { profileDir, taskTypes: true });
    expect(embedder.taskTypes).toBe(true);
    const [objective, paraphrase, unrelated] = await embedder.embed([OBJECTIVE, PARAPHRASE, UNRELATED], { roles: ["query", "document", "document"] });
    const near = cosineSimilarity(objective!, paraphrase!);
    const far = cosineSimilarity(objective!, unrelated!);
    const rule = Math.round((far + 0.3 * (near - far)) * 100) / 100;
    console.error(`[embedder.live] task types: cos(paraphrase)=${near.toFixed(4)} cos(unrelated)=${far.toFixed(4)} rule floor=${rule.toFixed(2)} shipped queryFloor=${String(EMBEDDER_ROUTES.gemini.queryFloor)}`);
    expect(near).toBeGreaterThan(far);
    const floor = EMBEDDER_ROUTES.gemini.queryFloor!;
    expect(vectorCredit(far, floor)).toBe(0);
    expect(vectorCredit(near, floor)).toBeGreaterThan(0);
  }, 60_000);
});

describe.skipIf(process.env.TRENT_TEST_LIVE !== "1" || LOCAL === undefined)("[L0-5] live local embedder calibration", () => {
  it("separates each paraphrase from its unrelated line in both spaces, and the recorded floors get all three triples right", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-embed-live-local-"));
    try {
      const model = process.env.TRENT_EMBEDDER_LIVE_MODEL?.trim();
      const config = { memory: { embedder: { provider: LOCAL!, ...(model ? { model } : {}) } } };
      const symmetric = createEmbedder(config, {}, { profileDir: dir, useCache: false, taskTypes: false });
      const typed = createEmbedder(config, {}, { profileDir: dir, useCache: false });
      const spaces = [
        { name: "symmetric", pairs: await measureCalibration(symmetric.embed, false) },
        ...(typed.taskTypes ? [{ name: "query-prefixed", pairs: await measureCalibration(typed.embed, true) }] : []),
      ];
      const [probe] = await symmetric.embed(["."]);
      console.error(`[embedder.live] provider=${symmetric.provider} model=${symmetric.model} dims=${String(probe!.length)}`);
      for (const space of spaces) {
        const floor = floorFromPairs(space.pairs);
        const cosines = space.pairs.map((p, i) => `#${String(i + 1)} paraphrase=${p.near.toFixed(4)} unrelated=${p.far.toFixed(4)}`).join("; ");
        console.error(`[embedder.live] ${space.name}: ${cosines}; rule floor=${floor === undefined ? "none (not separable)" : floor.toFixed(2)}`);
        for (const pair of space.pairs) expect(pair.near).toBeGreaterThan(pair.far);
      }
      const recorded = RECORDED_LOCAL_FLOORS[normaliseLocalModel(symmetric.model)];
      if (recorded === undefined) {
        console.error("[embedder.live] no recorded floor for this model: it is calibrated on first use");
        return;
      }
      expect(calibrationSanity(spaces[0]!.pairs, recorded.vectorFloor)).toBe(3);
      if (spaces[1] !== undefined) expect(calibrationSanity(spaces[1].pairs, recorded.queryFloor)).toBe(3);
      expect(probe!.length).toBe(symmetric.dims);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
