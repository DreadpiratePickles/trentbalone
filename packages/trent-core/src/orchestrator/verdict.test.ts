/**
 * [P2-11] A run that loses model calls part-way ends with a verdict a person or a cron incident can
 * read: which steps died, of what, at which provider, what the run spent, and whether the brief was
 * written — never "the run ended without a verdict" when steps ran, and never `completed`.
 *
 * The pipeline half runs the REAL app pipeline with a fake `ModelGateway` and nothing else injected,
 * so every seat call goes through the P2-8 seat port exactly as in production (today's live runs on
 * Google's free tier: a 429 mid-run). No live model is called.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ProviderHttpError } from "../model-gateway/retry.js";
import type { GatewayCompletion, GatewayStreamRequest, ModelGateway } from "../model-gateway/types.js";
import type { OrcEvent, OrchestrationRunSnapshot } from "./types.js";
import { buildVerdict, describeModelFailure, verdictOf, type ModelCallFailure } from "./verdict.js";

const QUOTA_BODY = "You exceeded your current quota";
const quota = (retryAfter?: string): ProviderHttpError =>
  new ProviderHttpError({ provider: "google", status: 429, statusText: "Too Many Requests", body: QUOTA_BODY, ...(retryAfter === undefined ? {} : { headers: { "retry-after": retryAfter } }) });

const step = (id: string, agentRole: string, status: string) => ({ id, title: `${agentRole} part`, agentRole, status });

describe("[P2-11] the verdict's shape and its one-line summary", () => {
  const limited = describeModelFailure(quota("3600"));

  it("classifies a provider error: class, provider, status, the wait it asked for, redacted text", () => {
    expect(limited).toMatchObject({ errorClass: "rate_limit", provider: "google", status: 429, retryAfterSeconds: 3600 });
    expect(limited.message).toContain("HTTP 429");
    // The app's seat executor keeps only a message; the same facts are read back out of it.
    expect(describeModelFailure("google request failed with HTTP 503 Service Unavailable")).toMatchObject({ errorClass: "dependency", provider: "google", status: 503 });
    expect(describeModelFailure(new Error("401 status code (no body)"))).toMatchObject({ errorClass: "auth", status: 401 });
    expect(describeModelFailure(new Error("rejected sk-live12345678abcdef")).message).not.toContain("sk-live12345678abcdef");
  });

  it("names the provider, the status and the class once per cause, the seats it hit, the consolidation and the wait", () => {
    const verdict = buildVerdict({
      steps: [step("s1", "growth", "completed"), step("s2", "content", "failed"), step("s3", "ceo", "completed"), step("s4", "analyst", "completed")],
      failures: new Map<string, readonly ModelCallFailure[]>([["s2", [limited, limited]], ["s3", [limited]]]),
      consolidation: { outcome: "skipped" },
      costCents: 7,
    });
    expect(verdict).toMatchObject({
      reason: "model_calls_failed",
      completedSteps: 2,
      totalSteps: 4,
      costCents: 7,
      consolidation: "skipped",
      retryAfterSeconds: 3600,
      summary: `2 of 4 steps failed: google HTTP 429 rate_limit (${QUOTA_BODY}) on content, ceo; consolidation skipped; retry after 3600s`,
    });
    expect(verdict?.failedSteps.map((f) => [f.seat, f.step, f.errorClass, f.attempts])).toEqual([["content", "s2", "rate_limit", 2], ["ceo", "s3", "rate_limit", 1]]);
    expect(verdict?.failedSteps[0]?.message).toContain("HTTP 429");
  });

  it("a consolidator that failed gives the same shape with consolidation failed and no failed step", () => {
    const verdict = buildVerdict({
      steps: [step("s1", "growth", "completed"), step("s2", "content", "completed")],
      failures: new Map(),
      consolidation: { outcome: "failed", error: limited },
      costCents: 3,
    });
    expect(verdict).toMatchObject({ reason: "model_calls_failed", failedSteps: [], completedSteps: 2, consolidation: "failed", retryAfterSeconds: 3600 });
    expect(verdict?.summary).toBe(`all 2 steps completed; consolidation failed: google HTTP 429 rate_limit (${QUOTA_BODY}); retry after 3600s`);
  });

  it("keeps every distinct error a step saw, counts steps that never finished, and says nothing when nothing failed", () => {
    const first = describeModelFailure(new ProviderHttpError({ provider: "openai", status: 503, statusText: "Service Unavailable" }));
    const second = describeModelFailure(new ProviderHttpError({ provider: "openai", status: 502, statusText: "Bad Gateway" }));
    const verdict = buildVerdict({
      steps: [step("s1", "engineer", "failed"), { ...step("s2", "ceo", "failed"), output: 'Skipped — dependency "engineer part" failed.' }, step("s3", "analyst", "completed")],
      failures: new Map([["s1", [first, second]]]),
      consolidation: { outcome: "completed" },
      costCents: 0,
    });
    expect(verdict?.summary).toBe(
      "1 of 3 steps failed: openai HTTP 503 dependency (Service Unavailable), then openai HTTP 502 dependency (Bad Gateway) on engineer; 1 more did not complete; consolidation completed",
    );
    expect(verdict?.retryAfterSeconds).toBeUndefined();
    expect(buildVerdict({ steps: [step("s1", "ceo", "completed")], failures: new Map(), consolidation: { outcome: "completed" }, costCents: 1 })).toBeUndefined();
  });

  it("a planner that failed and a drain that died each say so, with nothing invented", () => {
    const planner = buildVerdict({ steps: [], failures: new Map(), consolidation: { outcome: "skipped" }, costCents: 0, planner: limited });
    expect(planner).toMatchObject({ reason: "model_calls_failed", totalSteps: 0, failedSteps: [], consolidation: "skipped" });
    expect(planner?.summary).toBe(`planner call failed: google HTTP 429 rate_limit (${QUOTA_BODY}); no step ran; retry after 3600s`);
    const stopped = buildVerdict({ steps: [step("s1", "ceo", "completed"), step("s2", "growth", "pending")], failures: new Map(), consolidation: { outcome: "skipped" }, costCents: 2, stopped: "trace sink exploded" });
    expect(stopped).toMatchObject({ reason: "run_error", completedSteps: 1 });
    expect(stopped?.summary).toBe("the run stopped on an error: trace sink exploded; 1 of 2 steps completed; consolidation skipped");
  });

  it("verdictOf reads a frame or a snapshot and refuses anything else", () => {
    const verdict = buildVerdict({ steps: [], failures: new Map(), consolidation: { outcome: "skipped" }, costCents: 0, planner: limited });
    expect(verdictOf({ kind: "run_failed", verdict })).toEqual(verdict);
    expect(verdictOf({ kind: "run_failed" })).toBeUndefined();
    expect(verdictOf({ verdict: { reason: "made up" } })).toBeUndefined();
    expect(verdictOf(undefined)).toBeUndefined();
  });
});

// --- the pipeline -------------------------------------------------------------------------------

const ENV_KEYS = [
  "NODE_ENV", "DATABASE_URL", "REDIS_URL", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "TRENT_QUEUE_FALLBACK",
  "TRENT_EVAL_SYNC_QUEUE", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "MISTRAL_API_KEY",
  "OPENROUTER_API_KEY", "GOOGLE_MODEL_FAST", "GOOGLE_MODEL_DEFAULT", "GOOGLE_MODEL_STRONG", "MODEL_PREFERRED_PROVIDER",
  "MODEL_ALLOWED_PROVIDERS", "CRITIC_RUBRIC_ENABLED", "ORCHESTRATION_PLAN_VALIDATOR_ENABLED",
] as const;
const savedEnv: Record<string, string | undefined> = {};
const MODEL = "gemini-3.7-flash";
const OBJECTIVE = "Write a launch note for the bakery";
const planned = (id: string, role: string, dependsOn: string[]) => ({ id, title: `${role} part`, rationale: "r", agentRole: role, dependsOn, expectedOutput: "text", riskLevel: "low", needsApproval: false });
/** Four seats; content is the second step to run on the growth branch. */
const PLAN = { objective: OBJECTIVE, reasoning: "four seats", steps: [planned("s1", "growth", []), planned("s2", "content", ["s1"]), planned("s3", "ceo", ["s2"]), planned("s4", "analyst", [])], successCriteria: ["a note"], blockers: [] };

type Call = { kind: "seat" | "planner" | "critic" | "consolidator" | "other"; seat?: string };

function callOf(req: GatewayStreamRequest): Call {
  // The seat port pins the model the app resolved; the planner, critic and consolidator ports do not.
  // The seat's own user prompt opens "Company: ...\nSeat: <role>"; upstream context may name other seats later.
  if (req.model !== undefined) return { kind: "seat", seat: /^Seat: (\S+)/m.exec(req.messages.find((m) => m.role === "user")?.content ?? "")?.[1] ?? "?" };
  const system = req.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
  if (/chief orchestrator|long-horizon planner/i.test(system)) return { kind: "planner" };
  if (/quality supervisor/i.test(system)) return { kind: "critic" };
  if (/consolidator/i.test(system)) return { kind: "consolidator" };
  return { kind: "other" };
}

function reply(call: Call): string {
  if (call.kind === "planner") return JSON.stringify(PLAN);
  if (call.kind === "critic") return JSON.stringify({ verdict: "pass", reason: "on brief" });
  if (call.kind === "consolidator") return "TL;DR — the note is written.";
  return JSON.stringify({ toolCall: null, summary: `${call.seat ?? "seat"} did its part`, findings: [], recommendations: [], workRequests: [] });
}

/** Answers like flash; `fail` decides which calls die, and with what. */
function fakeGateway(calls: Call[], fail: (call: Call) => Error | undefined): ModelGateway {
  return {
    complete: async (req: GatewayStreamRequest): Promise<GatewayCompletion> => {
      const call = callOf(req);
      calls.push(call);
      const error = fail(call);
      if (error !== undefined) throw error;
      return { text: reply(call), provider: "google", model: MODEL, modelTier: "sonnet", inputTokens: 20_000, outputTokens: 2_000, cachedInputTokens: 0, costCents: 1, estimated: false, priced_as_default: false, unpriced: false, finishReason: "stop" } as GatewayCompletion;
    },
    // eslint-disable-next-line require-yield
    stream: async function* () {
      throw new Error("unused");
    },
    resolveRoute: () => ({ providers: ["google"], fallbackChain: ["google"], modelTier: "sonnet", explicitModel: MODEL, modelForProvider: () => MODEL }),
    configuredProviders: () => ["google"],
    estimateCostCents: () => 0,
  } as unknown as ModelGateway;
}

interface Scenario {
  calls: Call[];
  events: OrcEvent[];
  snapshot?: OrchestrationRunSnapshot;
  rejected?: unknown;
}

async function scenario(label: string, fail: (call: Call) => Error | undefined, traceSink?: (event: OrcEvent) => void): Promise<Scenario> {
  const calls: Call[] = [];
  const { createOrchestrator } = await import("./index.js");
  const orchestrator = createOrchestrator({ model: { provider: "google", model: MODEL }, gateway: fakeGateway(calls, fail), ...(traceSink ? { traceSink } : {}) });
  const companyId = await orchestrator.ensureCompany({ name: `P2-11 ${label}`, vision: "bread at 6 am" });
  const handle = orchestrator.run({ companyId, objective: OBJECTIVE });
  const events: OrcEvent[] = [];
  for await (const event of handle) events.push(event);
  try {
    return { calls, events, snapshot: await handle.result() };
  } catch (rejected) {
    return { calls, events, rejected };
  }
}

const framedCents = (events: readonly OrcEvent[]): number =>
  events.filter((e) => e.kind === "step_end" || e.kind === "consolidate_end").reduce((sum, e) => sum + (e.step?.costCents ?? 0), 0);
const terminal = (events: readonly OrcEvent[]) => events.filter((e) => e.kind === "run_done" || e.kind === "run_failed" || e.kind === "run_cancelled");
const seatCalls = (s: Scenario, seat: string) => s.calls.filter((c) => c.kind === "seat" && c.seat === seat).length;

describe("[P2-11] a mid-run model failure, through the real pipeline", () => {
  beforeAll(() => {
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    process.env.NODE_ENV = "production";
  });
  afterAll(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("the second seat step's 429 on every attempt: failed, model_calls_failed, the step, the provider, the spend", async () => {
    const s = await scenario("seat 429", (call) => (call.kind === "seat" && call.seat === "content" ? quota() : undefined));
    const verdict = verdictOf(s.snapshot);
    expect(s.snapshot?.status).toBe("failed");
    expect(verdict).toMatchObject({ reason: "model_calls_failed", completedSteps: 3, totalSteps: 4, consolidation: "skipped" });
    expect(verdict?.failedSteps).toHaveLength(1);
    expect(verdict?.failedSteps[0]).toMatchObject({ seat: "content", step: "s2", errorClass: "rate_limit", provider: "google", status: 429 });
    expect(verdict?.failedSteps[0]?.message).toContain(QUOTA_BODY);
    expect(verdict?.summary).toMatch(/^1 of 4 steps failed: google HTTP 429 rate_limit \(You exceeded your current quota\) on content; consolidation skipped$/);
    // Auto-recovery re-ran it once (no Retry-After), and the step's own frames name google, not the
    // last provider the app's fallback loop refused.
    expect(s.events.filter((e) => e.kind === "step_note" && /auto recovery cycle 1 of 1/.test(e.detail ?? ""))).toHaveLength(1);
    for (const end of s.events.filter((e) => e.kind === "step_end" && e.step?.id === "s2")) expect(end.detail ?? end.step?.output ?? "").toContain("HTTP 429");
    // The provider that just said "quota" is not asked for a brief.
    expect(s.calls.filter((c) => c.kind === "consolidator")).toHaveLength(0);
    // One terminal frame, run_failed, carrying the same verdict; the spend is what the frames charged.
    const ends = terminal(s.events);
    expect(ends.map((e) => e.kind)).toEqual(["run_failed"]);
    expect(verdictOf(ends[0])).toEqual(verdict);
    expect(ends[0]?.detail).toBe(verdict?.summary);
    expect(s.snapshot?.summary).toBe(`Run failed: ${verdict?.summary}`);
    expect(verdict?.costCents).toBe(framedCents(s.events));
    expect(verdict?.costCents).toBeGreaterThan(0);
  }, 120_000);

  it("a 429 whose Retry-After is longer than a re-run can wait is not re-run, and the wait is surfaced", async () => {
    const s = await scenario("seat 429 hold", (call) => (call.kind === "seat" && call.seat === "content" ? quota("3600") : undefined));
    const verdict = verdictOf(s.snapshot);
    expect(s.events.filter((e) => e.kind === "step_note" && /auto recovery/.test(e.detail ?? ""))).toEqual([]);
    expect(s.events.filter((e) => e.kind === "step_start" && e.step?.id === "s2")).toHaveLength(1);
    expect(verdict).toMatchObject({ reason: "model_calls_failed", retryAfterSeconds: 3600 });
    expect(verdict?.failedSteps[0]).toMatchObject({ seat: "content", retryAfterSeconds: 3600, attempts: 1 });
    expect(verdict?.summary).toContain("retry after 3600s");
    const once = seatCalls(s, "content");
    expect(once).toBeGreaterThan(0);
    expect(once).toBeLessThanOrEqual(2); // one attempt of the seat loop: its first turn and its fallback turn
  }, 120_000);

  it("a consolidator whose call fails: the same shape, consolidation failed, every step completed", async () => {
    const s = await scenario("consolidator 429", (call) => (call.kind === "consolidator" ? quota("60") : undefined));
    const verdict = verdictOf(s.snapshot);
    expect(s.snapshot?.status).toBe("failed");
    expect(verdict).toMatchObject({ reason: "model_calls_failed", failedSteps: [], completedSteps: 4, totalSteps: 4, consolidation: "failed", retryAfterSeconds: 60 });
    expect(verdict?.consolidationError).toMatchObject({ errorClass: "rate_limit", provider: "google", status: 429 });
    expect(verdict?.summary).toBe(`all 4 steps completed; consolidation failed: google HTTP 429 rate_limit (${QUOTA_BODY}); retry after 60s`);
    expect(terminal(s.events).map((e) => [e.kind, e.detail])).toEqual([["run_failed", verdict?.summary]]);
    expect(verdict?.costCents).toBe(framedCents(s.events));
  }, 120_000);

  it("a drain that dies after steps ran still ends the stream with a verdict, and result() still names the error", async () => {
    let thrown = false;
    const s = await scenario("drain dies", () => undefined, (event) => {
      if (!thrown && event.kind === "step_end" && event.step?.id === "s3") {
        thrown = true;
        throw new Error("trace sink exploded");
      }
    });
    expect(String(s.rejected)).toContain("trace sink exploded");
    const ends = terminal(s.events);
    expect(ends.map((e) => e.kind)).toEqual(["run_failed"]);
    const verdict = verdictOf(ends[0]);
    expect(verdict?.reason).toBe("run_error");
    expect(verdict?.summary).toMatch(/^the run stopped on an error: trace sink exploded; (all 4|\d of 4) steps completed; consolidation skipped$/);
    expect(ends[0]?.detail).not.toContain("without a verdict");
  }, 120_000);
});

describe("[P2-11] the verdict reaches a cron history row and the quota hold unchanged", () => {
  it("records `Run failed: <summary>` and holds prompt-driven jobs on the HTTP 429 it names", async () => {
    const { CronRunner, readCronRuns } = await import("../cron/index.js");
    const { readCronIncidents } = await import("../cron/incidents.js");
    const { newCronJob, writeCronJobs } = await import("../tools/cron/index.js");
    const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-p2-11-cron-"));
    try {
      const job = newCronJob({ schedule: "@daily", prompt: "Write the launch note" }, "2026-09-25T08:00:00.000Z");
      writeCronJobs(profileDir, [job]);
      const verdict = buildVerdict({
        steps: [step("s1", "growth", "completed"), step("s2", "content", "failed")],
        failures: new Map([["s2", [describeModelFailure(quota("3600"))]]]),
        consolidation: { outcome: "skipped" },
        costCents: 4,
      })!;
      const frames: OrcEvent[] = [
        { kind: "run_start", runId: "orc_1", at: "2026-09-25T08:00:00.000Z" },
        { kind: "step_end", runId: "orc_1", at: "2026-09-25T08:00:01.000Z", step: { id: "s1", status: "completed", costCents: 4 } },
        { kind: "run_failed", runId: "orc_1", at: "2026-09-25T08:00:02.000Z", detail: verdict.summary, run: { status: "failed", summary: `Run failed: ${verdict.summary}` }, verdict } as OrcEvent,
      ];
      const runner = new CronRunner({ profileDir, run: async function* () { yield* frames; }, now: () => new Date("2026-09-25T08:00:03.000Z"), log: () => undefined });
      const row = await runner.runNow(job.id);
      expect(row).toMatchObject({ status: "failed", summary: `Run failed: ${verdict.summary}`, costCents: 4 });
      expect(readCronRuns(profileDir, job.id).at(-1)?.summary).toBe(`Run failed: ${verdict.summary}`);
      expect(readCronIncidents(profileDir).quota_hold_until).toBeDefined();
    } finally {
      fs.rmSync(profileDir, { recursive: true, force: true });
    }
  });
});
