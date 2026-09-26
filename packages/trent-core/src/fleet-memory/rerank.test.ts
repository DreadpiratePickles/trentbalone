/**
 * [P2-13] The brain reranker: a second stage over the pool "dense top-20 U lexical top-20" that asks
 * the profile's cheapest model, in ONE call per query, how well each candidate answers the question,
 * and turns "nothing answers it" into an empty recall block.
 *
 * Every model call here is a fake gateway. The live measurement is `improve/docs-corpus.live.test.ts`.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { TrentConfigSchema } from "../config/schema.js";
import { installSpendLedger, openSpendLedger } from "../governance/spend-ledger.js";
import type { GatewayCompletion, GatewayStreamRequest } from "../model-gateway/types.js";
import { closeRunScope, openRunScope } from "../orchestrator/run-hooks.js";
import { createBrain, type Brain, type BrainExec } from "./brain.js";
import { recallFromBrain } from "./brain-index.js";
import type { CalibratedEmbedFn } from "./lexical.js";
import {
  RERANK_POOL_PER_RANKER,
  RERANK_SEAT,
  pickRelevant,
  rerankModelFor,
  rerankPool,
  rerankerForProfile,
  resolveBrainRerank,
  type BrainReranker,
  type RerankCandidate,
} from "./rerank.js";
import { RERANK_SNIPPET_CHARS, buildRerankPrompt, createLlmReranker, estimateRerankMicroCents, parseRerankReply } from "./rerank-llm.js";

const MODEL = "gemini-3.5-flash-lite";
const noGit: BrainExec = () => ({ code: 127, stdout: "", stderr: "git: command not found" });

function completion(text: string, over: Partial<GatewayCompletion> = {}): GatewayCompletion {
  return { text, provider: "google", model: MODEL, modelTier: "sonnet", inputTokens: 4_000, outputTokens: 300, cachedInputTokens: 0, costCents: 1, estimated: false, priced_as_default: false, finishReason: "stop", ...over };
}

function fakeGateway(reply: (req: GatewayStreamRequest) => string | Error): { calls: GatewayStreamRequest[]; gateway: { complete: (req: GatewayStreamRequest) => Promise<GatewayCompletion> } } {
  const calls: GatewayStreamRequest[] = [];
  return {
    calls,
    gateway: {
      complete: async (req) => {
        calls.push(req);
        const out = reply(req);
        if (out instanceof Error) throw out;
        return completion(out, { model: req.model ?? MODEL });
      },
    },
  };
}

const candidates: RerankCandidate[] = [
  { id: "fleet#11", title: "Fleet", heading: "Seats", text: `Every seat carries its own toolset. ${"x".repeat(600)}` },
  { id: "doctor#13", title: "Doctor", text: "Exit codes: 0 ok, 1 warn, 2 fail." },
  { id: "social#5", title: "Social", heading: "Buffer", text: "Posts go through Buffer's queue." },
];

describe("[P2-13] the rerank prompt and reply", () => {
  it("is compact: short labels, the question once, and at most the first 300 characters of each candidate", () => {
    const { messages, labels } = buildRerankPrompt("which seats carry the business toolset", candidates);
    expect(labels).toEqual(["fleet#11", "doctor#13", "social#5"]);
    const user = messages.map((m) => m.content).join("\n");
    expect(user).toContain("which seats carry the business toolset");
    expect(user).toContain("[c1] Fleet > Seats: Every seat carries its own toolset.");
    expect(user).toContain("[c2] Doctor: Exit codes");
    expect(user).not.toContain("fleet#11");
    expect(user).not.toContain("x".repeat(RERANK_SNIPPET_CHARS));
    expect(user.length).toBeLessThan(1_800);
  });

  it("maps the reply back to chunk ids: fences and a bare array accepted, unknown labels dropped, first score wins, scores clamped to 0..1", () => {
    const labels = ["fleet#11", "doctor#13", "social#5"];
    expect(parseRerankReply('```json\n{"ranked":[{"id":"c3","score":0.9},{"id":"c9","score":1},{"id":"c1","score":1.4},{"id":"c3","score":0.1}]}\n```', labels)).toEqual([
      { id: "social#5", score: 0.9 },
      { id: "fleet#11", score: 1 },
    ]);
    expect(parseRerankReply('[{"id":"c2","score":-0.2}]', labels)).toEqual([{ id: "doctor#13", score: 0 }]);
    expect(() => parseRerankReply("I think c1 is best", labels)).toThrow(/rerank/i);
  });

  it("keeps what clears the no-answer threshold, best first, ties in pool order; nothing clears it is an abstention", () => {
    const order = ["a", "b", "c", "d"];
    expect(pickRelevant([{ id: "c", score: 0.6 }, { id: "b", score: 0.9 }, { id: "a", score: 0.6 }, { id: "d", score: 0.4 }], 0.5, order).map((s) => s.id)).toEqual(["b", "a", "c"]);
    expect(pickRelevant([{ id: "a", score: 0.49 }], 0.5, order)).toEqual([]);
  });
});

describe("[P2-13] the LLM reranker", () => {
  let profileDir: string;

  beforeEach(() => {
    profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-rerank-"));
  });

  afterEach(() => {
    installSpendLedger(undefined);
    fs.rmSync(profileDir, { recursive: true, force: true });
  });

  it("makes ONE pinned call per query at temperature 0, and returns the picks above the threshold", async () => {
    const { calls, gateway } = fakeGateway(() => '{"ranked":[{"id":"c3","score":0.95},{"id":"c1","score":0.7},{"id":"c2","score":0.1}]}');
    const rerank = createLlmReranker({ gateway, model: MODEL, maxCentsPerQuery: 1, minScore: 0.5 });
    const outcome = await rerank({ query: "how are posts scheduled", candidates });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ model: MODEL, temperature: 0 });
    expect(outcome.status).toBe("ranked");
    if (outcome.status !== "ranked") return;
    expect(outcome.picks).toEqual([{ id: "social#5", score: 0.95 }, { id: "fleet#11", score: 0.7 }]);
    expect(outcome.usage).toMatchObject({ model: MODEL, inputTokens: 4_000, outputTokens: 300 });
    // 4,000 x $0.30/M + 300 x $2.50/M = 0.12 + 0.075 cents = 195,000 micro-cents.
    expect(outcome.usage!.microCents).toBe(195_000);
  });

  it("abstains when no candidate clears the threshold: the question has no answer here", async () => {
    const { gateway } = fakeGateway(() => '{"ranked":[{"id":"c1","score":0.3},{"id":"c2","score":0.2},{"id":"c3","score":0}]}');
    const outcome = await createLlmReranker({ gateway, model: MODEL, maxCentsPerQuery: 1, minScore: 0.5 })({ query: "SAML single sign-on", candidates });
    expect(outcome.status).toBe("abstained");
  });

  it("refuses a rerank whose worst case exceeds max_cents_per_query, without calling the model", async () => {
    const { calls, gateway } = fakeGateway(() => "{}");
    const tiny = createLlmReranker({ gateway, model: MODEL, maxCentsPerQuery: 0.01, minScore: 0.5 });
    const outcome = await tiny({ query: "anything", candidates });
    expect(outcome.status).toBe("refused");
    expect(calls).toHaveLength(0);
    const bound = estimateRerankMicroCents({ model: MODEL, promptChars: 3_000, maxOutputTokens: 2_048 });
    expect(bound).toBeGreaterThan(0.01 * 1_000_000);
  });

  it("a failed call or an unreadable reply is a `failed` outcome, never a thrown recall", async () => {
    const down = createLlmReranker({ gateway: fakeGateway(() => new Error("HTTP 429")).gateway, model: MODEL, maxCentsPerQuery: 1, minScore: 0.5 });
    expect((await down({ query: "q", candidates })).status).toBe("failed");
    const garbled = createLlmReranker({ gateway: fakeGateway(() => "no json here").gateway, model: MODEL, maxCentsPerQuery: 1, minScore: 0.5 });
    expect((await garbled({ query: "q", candidates })).status).toBe("failed");
  });

  it("meters the call on the run it belongs to, so the ledger row carries the run's surface", async () => {
    const ledger = openSpendLedger({ profileDir });
    installSpendLedger(ledger);
    openRunScope([], "run_rr", { companyId: "co", objective: "q", surface: "cron" });
    const { gateway } = fakeGateway(() => '{"ranked":[{"id":"c1","score":0.9}]}');
    await createLlmReranker({ gateway, model: MODEL, maxCentsPerQuery: 1, minScore: 0.5 })({ query: "q", candidates, runId: "run_rr", seat: "analyst" });
    closeRunScope([], "run_rr");
    const rows = ledger.rows().filter((r) => r.run_id === "run_rr");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ surface: "cron", seat: RERANK_SEAT, model: MODEL, provider: "google", inputTokens: 4_000, outputTokens: 300, cents: 1 });
  });
});

describe("[P2-13] the candidate pool", () => {
  it("is the top 20 by cosine united with the top 20 lexical matches, in the blend's order", () => {
    const n = 50;
    const ids = Array.from({ length: n }, (_, i) => `c${String(i).padStart(2, "0")}`);
    // Cosine falls with i; lexical rises with i and is 0 for the first 25; the blend favours the middle.
    const cosines = ids.map((_, i) => 0.9 - i * 0.01);
    const lexical = ids.map((_, i) => (i < 25 ? 0 : i / 100));
    const blend = ids.map((_, i) => 1 - Math.abs(i - 25) / 50);
    const pool = rerankPool({ ids, blend, lexical, cosines });
    const members = new Set(pool.map((i) => ids[i]));
    expect(RERANK_POOL_PER_RANKER).toBe(20);
    expect(members.size).toBe(40);
    for (let i = 0; i < 20; i += 1) expect(members.has(ids[i]), `dense ${String(i)}`).toBe(true);
    for (let i = 30; i < 50; i += 1) expect(members.has(ids[i]), `lexical ${String(i)}`).toBe(true);
    expect(members.has(ids[25])).toBe(false);
    const blendOrder = [...pool].sort((a, b) => blend[b]! - blend[a]! || ids[a]!.localeCompare(ids[b]!));
    expect(pool).toEqual(blendOrder);
  });

  it("with no vectors it is the lexical matches alone, and a zero TF-IDF score is not a match", () => {
    const ids = ["a", "b", "c"];
    expect(rerankPool({ ids, blend: [0.2, 0, 0.5], lexical: [0.2, 0, 0.5], cosines: [undefined, undefined, undefined] })).toEqual([2, 0]);
  });
});

describe("[P2-13] brain recall with a reranker", () => {
  let profileDir: string;
  let brain: Brain;

  beforeEach(() => {
    profileDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "trent-rerank-brain-")));
    brain = createBrain({ profileDir, exec: noGit });
    brain.ensure();
    brain.recordDecision({ title: "Churn is measured on self-serve cohorts", body: "Retention for self-serve subscriptions is reported monthly.", writer: "human", date: "2026-09-10" });
    brain.appendNote({ text: "the invoice run reconciled 42 open invoices for churn review", writer: "finance", runId: "run-0" });
    // A decision of its own, so it is a chunk of its own (the two notes above share one daily file).
    brain.recordDecision({ title: "Office plants", body: "the office plants are watered on fridays", writer: "ops", date: "2026-09-11" });
  });

  afterEach(() => {
    fs.rmSync(profileDir, { recursive: true, force: true });
  });

  /** Chunks that mention churn get cosine 0.7; everything else 0.5 — under the 0.6 floor. */
  const embed: CalibratedEmbedFn = Object.assign(
    async (texts: readonly string[]) => texts.map((t, i) => (i === texts.length - 1 ? [1, 0] : t.includes("churn") ? [0.7, Math.sqrt(0.51)] : [0.5, Math.sqrt(0.75)])),
    { vectorFloor: 0.6 },
  );

  it("hands the reranker the pool, puts its picks first, then the rest of what the blend called related", async () => {
    const seen: string[][] = [];
    const rerank: BrainReranker = async (request) => {
      seen.push(request.candidates.map((c) => c.id));
      const plants = request.candidates.find((c) => c.text.includes("plants"))!;
      return { status: "ranked", picks: [{ id: plants.id, score: 0.8 }], scores: [{ id: plants.id, score: 0.8 }] };
    };
    const hybrid = await recallFromBrain({ profileDir, brain, seat: "analyst", objective: "how is churn measured", embed });
    const reranked = await recallFromBrain({ profileDir, brain, seat: "analyst", objective: "how is churn measured", embed, rerank });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.length).toBe(3);
    expect(reranked.items[0]!.snippet).toContain("plants");
    expect(reranked.items.slice(1).map((i) => i.id)).toEqual(hybrid.items.map((i) => i.id).filter((id) => id !== reranked.items[0]!.id));
    expect(reranked.rerank).toMatchObject({ status: "ranked", pool: 3 });
  });

  it("an abstention empties the block; a refusal or failure keeps the blend's own order", async () => {
    const abstain: BrainReranker = async () => ({ status: "abstained", scores: [] });
    const refused: BrainReranker = async () => ({ status: "refused", reason: "over budget", estimateMicroCents: 2_000_000 });
    const hybrid = await recallFromBrain({ profileDir, brain, seat: "analyst", objective: "how is churn measured", embed });
    expect(hybrid.items.length).toBeGreaterThan(0);
    const empty = await recallFromBrain({ profileDir, brain, seat: "analyst", objective: "how is churn measured", embed, rerank: abstain });
    expect(empty.block).toBe("");
    expect(empty.rerank?.status).toBe("abstained");
    const kept = await recallFromBrain({ profileDir, brain, seat: "analyst", objective: "how is churn measured", embed, rerank: refused });
    expect(kept.items.map((i) => i.id)).toEqual(hybrid.items.map((i) => i.id));
    expect(kept.rerank?.status).toBe("refused");
  });
});

describe("[P2-13] brain.rerank in config", () => {
  it("is off unless asked for; a named mode takes the shipped cap (1 cent) and threshold (0.5)", () => {
    const parsed = TrentConfigSchema.parse({});
    expect(resolveBrainRerank(parsed.brain.rerank)).toEqual({ mode: "off", max_cents_per_query: 1, min_score: 0.5 });
    const on = TrentConfigSchema.parse({ brain: { rerank: { mode: "llm" } } });
    expect(resolveBrainRerank(on.brain.rerank)).toEqual({ mode: "llm", max_cents_per_query: 1, min_score: 0.5 });
    expect(() => TrentConfigSchema.parse({ brain: { rerank: { mode: "cross-encoder" } } })).toThrow();
    expect(() => TrentConfigSchema.parse({ brain: { rerank: { mode: "llm", max_cents_per_query: 0 } } })).toThrow();
  });

  it("uses the named model, else the fast tier, else the profile model", () => {
    expect(rerankModelFor({ model: "gemini-3.6-flash", models: { fast: MODEL }, brain: { rerank: { mode: "llm", model: "gemini-2.0-flash" } } })).toBe("gemini-2.0-flash");
    expect(rerankModelFor({ model: "gemini-3.6-flash", models: { fast: MODEL } })).toBe(MODEL);
    expect(rerankModelFor({ model: MODEL })).toBe(MODEL);
  });

  it("builds no reranker when the mode is off, and a working one when it is llm", async () => {
    const { calls, gateway } = fakeGateway(() => '{"ranked":[{"id":"c1","score":0.9}]}');
    expect(rerankerForProfile({ model: MODEL }, gateway)).toBeUndefined();
    const rerank = rerankerForProfile({ model: MODEL, brain: { rerank: { mode: "llm" } } }, gateway)!;
    expect((await rerank({ query: "q", candidates })).status).toBe("ranked");
    expect(calls[0]!.model).toBe(MODEL);
  });
});
