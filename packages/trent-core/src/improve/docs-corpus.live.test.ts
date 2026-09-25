/**
 * [P2-6] The live measurement behind `docs-corpus.test.ts`: the docs corpus ranked by the shipped
 * ranker with the real `gemini-embedding-001` embedder, in three modes, with the spend metered.
 *
 * Opt-in twice: `TRENT_TEST_LIVE=1` and a `GEMINI_API_KEY` in the environment (never printed, never
 * written). `TRENT_RECORD_DOCS_CORPUS=1` also writes `fixtures/docs-corpus/embeddings.json`, the
 * recorded cosines the offline suite replays. Whenever a recording is present the test replays it
 * and asserts it reproduces the live ranking question for question — that equality is what makes
 * the offline number the live number.
 *
 * `TRENT_DOCS_CORPUS_CACHE_DIR` names a scratch profile directory whose embedding cache survives
 * between runs, so a second run pays only for texts that changed. `TRENT_DOCS_CORPUS_REPORT` names
 * a file the full JSON report is written to.
 *
 * Cost: the shipped embedder has no price table (`model-gateway/pricing.ts` prices chat models), so
 * the spend is the provider's reported token count — or, when a response carries none, the input
 * characters over 4 — at Google's published paid-tier list price for gemini-embedding-001, $0.15 per
 * million input tokens. The key's tier is not visible from the API, so this is the most it can cost.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { createBrain, type BrainExec } from "../fleet-memory/brain.js";
import { EMBEDDER_ROUTES, createEmbedder, type FetchLike } from "../fleet-memory/embedder.js";
import { chunkScorableText, importDocsCorpus, loadDocsCorpus, resolveDocsCorpusGoldens } from "./docs-corpus.js";
import { RECORDED_COSINES_FILE, readRecordedCosines, recordCosines, recordedEmbedFn, writeRecordedCosines } from "./recorded-embedder.js";
import { RETRIEVAL_MODES, formatModeTables, measureMode, rankerFor, type ModeReport } from "./retrieval-metrics.js";

const LIVE = process.env.TRENT_TEST_LIVE === "1" && (process.env.GEMINI_API_KEY ?? "").trim() !== "";
const RECORD = process.env.TRENT_RECORD_DOCS_CORPUS === "1";
const FIXTURE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "docs-corpus");
const USD_PER_MILLION_TOKENS = 0.15;
const SPEND_CAP_CENTS = 40;
const noGit: BrainExec = () => ({ code: 127, stdout: "", stderr: "git: command not found" });

interface Meter {
  requests: number;
  inputs: number;
  chars: number;
  reportedTokens: number;
  responsesWithUsage: number;
}

function meteredFetch(meter: Meter): FetchLike {
  return async (url, init) => {
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as { input?: unknown }) : {};
    const inputs = Array.isArray(body.input) ? body.input.filter((x): x is string => typeof x === "string") : [];
    meter.requests += 1;
    meter.inputs += inputs.length;
    meter.chars += inputs.reduce((sum, text) => sum + text.length, 0);
    const response = await fetch(url, init);
    if (response.ok) {
      const payload = (await response.clone().json().catch(() => ({}))) as { usage?: { prompt_tokens?: unknown; total_tokens?: unknown } };
      const tokens = Number(payload.usage?.prompt_tokens ?? payload.usage?.total_tokens ?? Number.NaN);
      if (Number.isFinite(tokens)) {
        meter.reportedTokens += tokens;
        meter.responsesWithUsage += 1;
      }
    }
    return response;
  };
}

/**
 * The Gemini OpenAI-compatible embeddings surface returns no `usage` (probed 2026-09-25), so tokens
 * are estimated from the characters sent: chars / 4 as the estimate and chars / 3 as the bound the
 * cap is checked against, since identifiers and Markdown tokenise denser than prose.
 */
function spend(meter: Meter): { tokens: number; source: string; cents: number; boundCents: number } {
  const reported = meter.responsesWithUsage === meter.requests && meter.requests > 0;
  const tokens = reported ? meter.reportedTokens : Math.ceil(meter.chars / 4);
  const bound = reported ? meter.reportedTokens : Math.ceil(meter.chars / 3);
  const centsFor = (n: number): number => (n * USD_PER_MILLION_TOKENS * 100) / 1_000_000;
  return { tokens, source: reported ? "provider usage" : "chars / 4 (no usage in the responses; bound chars / 3)", cents: centsFor(tokens), boundCents: centsFor(bound) };
}

/**
 * Embeds `texts` into the embedder's disk cache at a pace a free-tier key survives: at most
 * CHARS_PER_MINUTE characters sent per rolling minute (gemini-embedding-001's free tier allows
 * 30,000 tokens a minute; a 32-chunk batch is about 7,000), and a 65-second pause and retry on a
 * 429 the shipped embedder's own three quick attempts could not absorb. Everything after this reads
 * the cache, so the measurement itself makes no request for a chunk.
 */
const CHARS_PER_MINUTE = 60_000;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function warmCache(embed: (texts: readonly string[]) => Promise<number[][]>, texts: readonly string[], meter: Meter): Promise<void> {
  const batches: string[][] = [];
  let current: string[] = [];
  let size = 0;
  for (const text of texts) {
    if (current.length > 0 && (size + text.length > CHARS_PER_MINUTE / 3 || current.length >= 32)) {
      batches.push(current);
      current = [];
      size = 0;
    }
    current.push(text);
    size += text.length;
  }
  if (current.length > 0) batches.push(current);
  let windowStart = Date.now();
  let windowChars = 0;
  for (const batch of batches) {
    const batchChars = batch.reduce((sum, t) => sum + t.length, 0);
    if (windowChars + batchChars > CHARS_PER_MINUTE) {
      await sleep(Math.max(0, 61_000 - (Date.now() - windowStart)));
      windowStart = Date.now();
      windowChars = 0;
    }
    const before = meter.chars;
    for (let attempt = 1; ; attempt += 1) {
      try {
        await embed(batch);
        break;
      } catch (error) {
        if (attempt >= 4) throw error;
        await sleep(65_000);
        windowStart = Date.now();
        windowChars = 0;
      }
    }
    windowChars += meter.chars - before;
  }
}

const ranksOf = (report: ModeReport): Array<[string, number | null, string[]]> => report.perQuery.map((q) => [q.id, q.rank, [...q.ranked]]);

describe.skipIf(!LIVE)("[P2-6] the docs corpus against gemini-embedding-001, live", () => {
  it("measures lexical, embedding-only and hybrid, records the cosines when asked, and the replay equals the live ranking", async () => {
    const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "trent-docs-corpus-live-")));
    const cacheDir = process.env.TRENT_DOCS_CORPUS_CACHE_DIR ?? path.join(work, "cache-profile");
    fs.mkdirSync(path.join(work, "src"), { recursive: true });
    try {
      const brain = createBrain({ profileDir: path.join(work, "profile"), exec: noGit });
      brain.ensure();
      const corpus = loadDocsCorpus(FIXTURE_DIR);
      await importDocsCorpus(brain, corpus, path.join(work, "src"));
      const resolved = resolveDocsCorpusGoldens(brain, corpus);

      const meter: Meter = { requests: 0, inputs: 0, chars: 0, reportedTokens: 0, responsesWithUsage: 0 };
      const embedder = createEmbedder({ provider: "google" }, {}, { profileDir: cacheDir, env: process.env, fetchImpl: meteredFetch(meter) });
      expect(embedder.provider).toBe("gemini");

      await warmCache(embedder.embed, [...resolved.entries.map(chunkScorableText), ...corpus.questions.map((q) => q.query)], meter);
      const live: ModeReport[] = [];
      for (const mode of RETRIEVAL_MODES) {
        live.push(await measureMode({ mode, brain, rank: rankerFor(mode, brain, embedder.embed), answerable: resolved.answerable, noAnswer: resolved.noAnswer }));
      }

      const recordingFile = path.join(FIXTURE_DIR, RECORDED_COSINES_FILE);
      if (RECORD) {
        const table = await recordCosines({
          embed: embedder.embed,
          chunkTexts: resolved.entries.map(chunkScorableText),
          queries: corpus.questions.map((q) => q.query),
          provider: embedder.provider,
          model: embedder.model,
          vectorFloor: EMBEDDER_ROUTES.gemini.vectorFloor,
          capturedAt: new Date().toISOString(),
          note: "cosine of each question (row, keyed by sha256 of the query) against each chunk (column, keyed by sha256 of the text the ranker embeds), float32 base64; written by docs-corpus.live.test.ts",
        });
        writeRecordedCosines(recordingFile, table);
      }

      const cost = spend(meter);
      const replayed: ModeReport[] = [];
      if (fs.existsSync(recordingFile)) {
        const replay = recordedEmbedFn(readRecordedCosines(recordingFile));
        for (const mode of ["embedding", "hybrid"] as const) {
          replayed.push(await measureMode({ mode, brain, rank: rankerFor(mode, brain, replay), answerable: resolved.answerable, noAnswer: resolved.noAnswer }));
        }
        expect(replay.stats().missingQueries).toEqual([]);
        expect(replay.stats().missingChunks).toBe(0);
      }

      const report = { chunks: resolved.entries.length, answerable: resolved.answerable.length, noAnswer: resolved.noAnswer.length, meter, cost, live, replayed };
      if (process.env.TRENT_DOCS_CORPUS_REPORT) fs.writeFileSync(process.env.TRENT_DOCS_CORPUS_REPORT, JSON.stringify(report, null, 1), "utf8");
      console.log(`${formatModeTables(live)}\n\nembedding requests ${String(meter.requests)}, inputs ${String(meter.inputs)}, chars ${String(meter.chars)}, tokens ${String(cost.tokens)} (${cost.source}), ${cost.cents.toFixed(3)} cents (bound ${cost.boundCents.toFixed(3)}) at $${String(USD_PER_MILLION_TOKENS)}/M`);

      for (const replay of replayed) {
        const same = live.find((r) => r.mode === replay.mode)!;
        expect(ranksOf(replay), `${replay.mode} replay`).toEqual(ranksOf(same));
        expect(replay.noAnswer.perQuery.map((q) => q.abstained)).toEqual(same.noAnswer.perQuery.map((q) => q.abstained));
      }
      expect(cost.boundCents).toBeLessThan(SPEND_CAP_CENTS);
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  }, 1_500_000);
});
