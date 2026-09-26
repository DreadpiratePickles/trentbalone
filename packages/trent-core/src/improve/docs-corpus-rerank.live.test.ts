/**
 * [P2-13] The live rerank measurement: the docs corpus, the shipped first stage replayed from its
 * recorded cosines (no embedding call), and the shipped LLM reranker asking the profile's cheapest
 * model — `gemini-3.5-flash-lite`, the shipped default `model` — in one call per question, through
 * the real model gateway.
 *
 * Opt-in three times: `TRENT_TEST_LIVE=1`, `TRENT_DOCS_CORPUS_RERANK=1` and a `GEMINI_API_KEY` in the
 * environment (never printed). `TRENT_RECORD_DOCS_CORPUS=1` writes `fixtures/docs-corpus/rerank-scores.json`,
 * which the offline suite replays. `TRENT_DOCS_CORPUS_RERANK_LIMIT=n` runs the first n questions only
 * (a probe; never recorded). `TRENT_DOCS_CORPUS_FIRST_STAGE` names the cosine recording the pools come
 * from (default: the task-typed one when it exists). `TRENT_DOCS_CORPUS_RERANK_EFFORT` sets
 * `reasoning_effort`. `TRENT_DOCS_CORPUS_RERANK_REPORT` names a file for the JSON report.
 *
 * Money: each call is metered from the provider's own usage at list price (`rerank-llm.ts`); the
 * harness stops calling once the run has spent `TRENT_DOCS_CORPUS_RERANK_CAP_CENTS` (default 20), and a
 * refused rerank is recorded as refused, never retried. Calls are paced for a free-tier key.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { createBrain, type BrainExec } from "../fleet-memory/brain.js";
import type { BrainRerankReport } from "../fleet-memory/brain-index.js";
import { createLlmReranker } from "../fleet-memory/rerank-llm.js";
import type { BrainReranker } from "../fleet-memory/rerank.js";
import { isReasoningEffort } from "../model-gateway/call-policy.js";
import { createModelGateway } from "../model-gateway/index.js";
import type { GatewayCompletion, GatewayStreamRequest } from "../model-gateway/types.js";
import { importDocsCorpus, loadDocsCorpus, resolveDocsCorpusGoldens } from "./docs-corpus.js";
import { RECORDED_RERANK_FILE, recordingReranker, writeRecordedRerank, type RecordedRerankQuery } from "./docs-corpus-rerank.js";
import { RECORDED_COSINES_FILE, RECORDED_TASK_TYPE_COSINES_FILE, readRecordedCosines, recordedEmbedFn } from "./recorded-embedder.js";
import { formatModeTables, measureMode, rankerFor, rerankedRanker, summariseReranks } from "./retrieval-metrics.js";

const KEY = (process.env.GEMINI_API_KEY ?? "").trim();
const LIVE = process.env.TRENT_TEST_LIVE === "1" && process.env.TRENT_DOCS_CORPUS_RERANK === "1" && KEY !== "";
const RECORD = process.env.TRENT_RECORD_DOCS_CORPUS === "1";
const LIMIT = Number(process.env.TRENT_DOCS_CORPUS_RERANK_LIMIT ?? "") || undefined;
const CAP_MICRO_CENTS = (Number(process.env.TRENT_DOCS_CORPUS_RERANK_CAP_CENTS ?? "") || 20) * 1_000_000;
const EFFORT = process.env.TRENT_DOCS_CORPUS_RERANK_EFFORT;
const MODEL = "gemini-3.5-flash-lite";
const MIN_SCORE = 0.5;
const MAX_CENTS_PER_QUERY = 1;
const FIXTURE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "docs-corpus");
const noGit: BrainExec = () => ({ code: 127, stdout: "", stderr: "git: command not found" });
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** At most one call per `SPACING_MS`, and a 65-second pause and retry on a 429 the gateway's own retries did not absorb. */
const SPACING_MS = 5_000;
function pacedGateway(inner: { complete: (req: GatewayStreamRequest) => Promise<GatewayCompletion> }): { complete: (req: GatewayStreamRequest) => Promise<GatewayCompletion> } {
  let last = 0;
  return {
    complete: async (req) => {
      for (let attempt = 1; ; attempt += 1) {
        await sleep(Math.max(0, last + SPACING_MS - Date.now()));
        last = Date.now();
        try {
          return await inner.complete(req);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.log(`rerank call attempt ${String(attempt)} failed: ${message.slice(0, 120)}`);
          if (attempt >= 3 || !/429|quota|rate/i.test(message)) throw error;
          await sleep(65_000);
        }
      }
    },
  };
}

function firstStageFile(): string {
  const named = process.env.TRENT_DOCS_CORPUS_FIRST_STAGE;
  if (named !== undefined && named.trim() !== "") return named.trim();
  return fs.existsSync(path.join(FIXTURE_DIR, RECORDED_TASK_TYPE_COSINES_FILE)) ? RECORDED_TASK_TYPE_COSINES_FILE : RECORDED_COSINES_FILE;
}

describe.skipIf(!LIVE)("[P2-13] the docs corpus reranked by gemini-3.5-flash-lite, live", () => {
  it("measures the hybrid and the reranked recall on the same pools, meters every call, and records the scores when asked", async () => {
    const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "trent-docs-rerank-live-")));
    fs.mkdirSync(path.join(work, "src"), { recursive: true });
    try {
      const brain = createBrain({ profileDir: path.join(work, "profile"), exec: noGit });
      brain.ensure();
      const corpus = loadDocsCorpus(FIXTURE_DIR);
      await importDocsCorpus(brain, corpus, path.join(work, "src"));
      const resolved = resolveDocsCorpusGoldens(brain, corpus);
      const chosen = new Set(corpus.questions.slice(0, LIMIT ?? corpus.questions.length).map((q) => q.id));
      const answerable = resolved.answerable.filter((q) => chosen.has(q.id));
      const noAnswer = resolved.noAnswer.filter((q) => chosen.has(q.id));

      const stage = firstStageFile();
      const replay = recordedEmbedFn(readRecordedCosines(path.join(FIXTURE_DIR, stage)));
      const gateway = await createModelGateway({ apiKeys: { google: KEY }, preferredProvider: "google", allowedProviders: ["google"], models: { executor: MODEL } });

      let spent = 0;
      const live = createLlmReranker({
        gateway: pacedGateway(gateway),
        model: MODEL,
        maxCentsPerQuery: MAX_CENTS_PER_QUERY,
        minScore: MIN_SCORE,
        ...(EFFORT !== undefined && isReasoningEffort(EFFORT) ? { reasoningEffort: EFFORT } : {}),
        meter: (_runId, call) => {
          console.log(`rerank call: model=${call.model} input=${String(call.inputTokens)} output=${String(call.outputTokens)} estimated=${String(call.estimated)}`);
        },
      });
      const capped: BrainReranker = async (request) =>
        spent >= CAP_MICRO_CENTS ? { status: "refused", reason: "the harness spend cap is reached", estimateMicroCents: 0 } : live(request);
      const sink = new Map<string, RecordedRerankQuery>();
      const recorder = recordingReranker(capped, sink);
      const reports = new Map<string, BrainRerankReport | undefined>();

      const hybrid = await measureMode({ mode: "hybrid", brain, rank: rankerFor("hybrid", brain, replay), answerable, noAnswer });
      const reranked = await measureMode({
        mode: "rerank",
        brain,
        rank: rerankedRanker({
          brain,
          embed: replay,
          rerank: recorder,
          onReport: (query, report) => {
            reports.set(query, report);
            spent += report?.microCents ?? 0;
          },
        }),
        answerable,
        noAnswer,
      });

      const spend = summariseReranks(reports);
      if (RECORD && LIMIT === undefined) {
        writeRecordedRerank(path.join(FIXTURE_DIR, RECORDED_RERANK_FILE), {
          version: 1,
          model: MODEL,
          first_stage: stage,
          captured_at: new Date().toISOString(),
          note: `pool = cosine top-20 U TF-IDF top-20 from ${stage}; ${String(corpus.questions.length)} questions; scores as the reply gave them; usage metered from the provider; written by docs-corpus-rerank.live.test.ts`,
          queries: Object.fromEntries(sink),
        });
      }
      const report = { stage, model: MODEL, effort: EFFORT ?? "model default", minScore: MIN_SCORE, spend, hybrid, reranked, perQuery: [...sink.entries()] };
      if (process.env.TRENT_DOCS_CORPUS_RERANK_REPORT) fs.writeFileSync(process.env.TRENT_DOCS_CORPUS_RERANK_REPORT, JSON.stringify(report, null, 1), "utf8");
      console.log(`${formatModeTables([hybrid, reranked])}\n\nfirst stage ${stage}; rerank statuses ${JSON.stringify(spend.statuses)}; ${String(spend.totalMicroCents)} micro-cents total, mean ${spend.meanCentsPerQuery.toFixed(4)} cents/query, max ${spend.maxCentsPerQuery.toFixed(4)}`);

      expect(replay.stats().missingQueries).toEqual([]);
      expect(replay.stats().modeMismatches).toBe(0);
      expect(spend.maxCentsPerQuery).toBeLessThanOrEqual(MAX_CENTS_PER_QUERY);
      expect(spend.totalMicroCents).toBeLessThan(CAP_MICRO_CENTS + MAX_CENTS_PER_QUERY * 1_000_000);
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  }, 1_800_000);
});
