/**
 * [P2-1] A pinned run runs WHOLE on its pin: the planner, the critic, the consolidator and every seat.
 *
 * Offline, against the REAL pipeline and the REAL gateway routing: the gateway is the production
 * `createModelGateway` with only its provider stream replaced by a recorder, so the model each
 * planner/critic/consolidator call names is the one `routeWorkbenchStream` resolved from env; the
 * seats go through the app's own `executeSeatModel`, whose `resolveModelName(tier, provider)` names
 * the model the recorder sees and the step reports. Nothing here reaches a network.
 *
 * The first case is the control: an unpinned, tiered profile spreads its calls over its tier models,
 * which is what makes the second case's "every call names the pin" a real assertion.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { ProviderStreamFn } from "../model-gateway/types.js";
import type { OrcEvent, OrchestrationRunSnapshot, SeatChatRequest, SeatChatResponse } from "./types.js";

const ENV_KEYS = [
  "NODE_ENV",
  "DATABASE_URL",
  "REDIS_URL",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "TRENT_QUEUE_FALLBACK",
  "TRENT_EVAL_SYNC_QUEUE",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "MISTRAL_API_KEY",
  "OPENROUTER_API_KEY",
  "CRITIC_RUBRIC_ENABLED",
  "ORCHESTRATION_PLAN_VALIDATOR_ENABLED",
] as const;
/** The model variables one test writes and the next must not inherit. */
const MODEL_KEYS = [
  "GOOGLE_MODEL_FAST",
  "GOOGLE_MODEL_DEFAULT",
  "GOOGLE_MODEL_STRONG",
  "MODEL_PREFERRED_PROVIDER",
  "MODEL_ALLOWED_PROVIDERS",
  "WORKBENCH_PLANNER_MODEL",
  "WORKBENCH_EXECUTOR_MODEL",
  "TRENT_MODEL_FALLBACK_ON_PIN",
] as const;

const saved: Record<string, string | undefined> = {};
const TIERS = { fast: "gemini-3.5-flash-lite", executor: "gemini-3.5-flash", planner: "gemini-3.6-pro" };
const PIN = "gemini-3.6-flash";
const OBJECTIVE = "Say the word ready and nothing else.";

const PLAN = {
  objective: OBJECTIVE,
  reasoning: "Pin plan: two seats on two different tiers.",
  steps: [
    { id: "s1", title: "Pin step one: the CEO answers", rationale: "Answer.", agentRole: "ceo", dependsOn: [], expectedOutput: "ready", riskLevel: "low", needsApproval: false },
    { id: "s2", title: "Pin step two: the engineer checks", rationale: "Check.", agentRole: "engineer", dependsOn: ["s1"], expectedOutput: "ready", riskLevel: "low", needsApproval: false },
  ],
  successCriteria: ["The word ready."],
  blockers: [],
};

type Kind = "planner" | "critic" | "consolidator" | "seat" | "other";
type Call = { kind: Kind; provider: string; model: string };

function classify(system: string): Kind {
  if (/chief orchestrator|long-horizon planner/i.test(system)) return "planner";
  if (/quality supervisor/i.test(system)) return "critic";
  if (/consolidator/i.test(system)) return "consolidator";
  return "other";
}

/** The production gateway's provider stream, replaced: records the provider and model it was asked for. */
function recorder(calls: Call[]): ProviderStreamFn {
  return async function* (provider, model, input) {
    const system = input.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
    const kind = classify(system);
    calls.push({ kind, provider, model });
    const text =
      kind === "planner" ? JSON.stringify(PLAN) : kind === "critic" ? JSON.stringify({ verdict: "pass", reason: "pin critic: fine." }) : "TL;DR — ready.";
    yield { type: "token", content: text };
    yield { type: "usage", inputTokens: 100, outputTokens: 10 };
    yield { type: "finish", reason: "stop" };
  };
}

function seatTurn(): SeatChatResponse {
  return {
    choices: [{ message: { content: JSON.stringify({ toolCall: null, summary: "ready", findings: [], recommendations: [], workRequests: [] }) } }],
    usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 },
  };
}

async function runOnce(pin: string | undefined): Promise<{ calls: Call[]; events: OrcEvent[]; snapshot: OrchestrationRunSnapshot }> {
  const { createOrchestrator } = await import("./index.js");
  const { applyModelEnv } = await import("./model-env.js");
  const { createModelGateway } = await import("../model-gateway/index.js");
  const model = { provider: "google", model: TIERS.fast, models: TIERS, ...(pin === undefined ? {} : { pin }) };
  // The orchestrator applies this itself; it is applied first here only because the gateway handed
  // to it is built by the test, and a gateway freezes its provider policy when it is built.
  applyModelEnv(model);
  const calls: Call[] = [];
  const gateway = await createModelGateway({ streamProvider: recorder(calls), retry: { attempts: 1 } });
  const orchestrator = createOrchestrator({
    model,
    gateway,
    createChatCompletion: async (request: SeatChatRequest) => {
      calls.push({ kind: "seat", provider: "google", model: request.model });
      return seatTurn();
    },
  });
  const { store } = await import("@/lib/store");
  const company = await store.createCompany({ name: `pin ${pin ?? "none"}`, brief: { vision: "per-run model pin" } });
  const handle = orchestrator.run({ companyId: company.id, objective: OBJECTIVE });
  const events: OrcEvent[] = [];
  for await (const event of handle) events.push(event);
  return { calls, events, snapshot: await handle.result() };
}

describe("[P2-1] a pinned run runs on its pin for every call", () => {
  beforeAll(() => {
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    process.env.NODE_ENV = "production";
    // Configured, never called: the recorder answers every provider call.
    process.env.GEMINI_API_KEY = "test-key-not-real";
  });
  beforeEach(() => {
    for (const key of MODEL_KEYS) {
      if (!(key in saved)) saved[key] = process.env[key];
      delete process.env[key];
    }
  });
  afterEach(() => {
    for (const key of MODEL_KEYS) delete process.env[key];
  });
  afterAll(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("control: unpinned, a tiered profile's calls spread over its tier models", async () => {
    const { calls, snapshot } = await runOnce(undefined);
    expect(snapshot.status).toBe("completed");
    const models = new Set(calls.map((call) => call.model));
    expect(models.size).toBeGreaterThan(1);
    expect(models.has(PIN)).toBe(false);
  }, 60_000);

  it("pinned: the planner, the critic, the consolidator and every seat call name the pin, and so does every step", async () => {
    // An operator's own value that the pin must beat.
    process.env.GOOGLE_MODEL_STRONG = "gemini-2.5-pro";
    const { calls, events, snapshot } = await runOnce(PIN);
    expect(snapshot.status).toBe("completed");

    const kinds = new Set(calls.map((call) => call.kind));
    for (const kind of ["planner", "critic", "consolidator", "seat"] as const) expect(kinds, kind).toContain(kind);
    expect(calls.filter((call) => call.kind === "seat")).toHaveLength(2);
    for (const call of calls) expect(call, JSON.stringify(call)).toMatchObject({ provider: "google", model: PIN });

    const ends = events.filter((event) => event.kind === "step_end");
    expect(ends.length).toBeGreaterThanOrEqual(2);
    for (const end of ends) expect(end.step?.model, JSON.stringify(end.step)).toBe(PIN);
    for (const step of snapshot.steps) expect(step.model).toBe(PIN);
  }, 60_000);
});
