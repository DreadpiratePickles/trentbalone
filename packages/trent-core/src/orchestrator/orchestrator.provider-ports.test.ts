import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { GatewayCompletion, GatewayStreamRequest, ModelGateway } from "../model-gateway/types.js";
import type { OrcEvent, OrchestrationRunSnapshot, SeatChatRequest, SeatChatResponse } from "./types.js";

/**
 * Finding 1 of the live proof (04_verification/output/live-agents-and-tools.md): with a Gemini-only
 * key ONLY the seat agents reached the provider. The planner and the critic go through `callJson`
 * whose default path is OpenAI-only, and the consolidator through `callText`, which has no
 * injection point at all; all three silently fell back (deterministic plan, auto-pass critic, the
 * literal "Run completed — see step outputs."). A 3-step run made 4 provider calls.
 *
 * These tests pin the fix offline against the REAL pipeline with an injected model gateway that
 * records every call. The seats use the seat-level provider port; the planner, critic and
 * consolidator must reach the gateway.
 */

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
  "GOOGLE_MODEL_FAST",
  "GOOGLE_MODEL_DEFAULT",
  "GOOGLE_MODEL_STRONG",
  "MODEL_PREFERRED_PROVIDER",
  "MODEL_ALLOWED_PROVIDERS",
  "CRITIC_RUBRIC_ENABLED",
  "ORCHESTRATION_PLAN_VALIDATOR_ENABLED",
] as const;

const savedEnv: Record<string, string | undefined> = {};

function imitateFreshInstall(): void {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env.NODE_ENV = "production";
}

function restoreEnv(): void {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

const CONFIG_MODEL = "gemini-3.5-flash-lite";
const OBJECTIVE = "Summarise the operating brief in two lines.";
const FALLBACK_SUMMARY = "Run completed — see step outputs.";

/** One call the fake gateway answered, classified by the system prompt the pipeline sent. */
type RecordedCall = {
  kind: "planner" | "critic" | "consolidator" | "other";
  role: string | undefined;
  system: string;
  user: string;
};

function classify(system: string): RecordedCall["kind"] {
  if (/chief orchestrator|long-horizon planner/i.test(system)) return "planner";
  if (/quality supervisor/i.test(system)) return "critic";
  if (/consolidator/i.test(system)) return "consolidator";
  return "other";
}

const GATEWAY_PLAN = {
  objective: OBJECTIVE,
  reasoning: "Gateway plan: three explicit steps from the injected provider.",
  steps: [
    {
      id: "s1",
      title: "Gateway step one: read the brief",
      rationale: "Read the operating brief first.",
      agentRole: "ceo",
      dependsOn: [],
      expectedOutput: "The brief in two lines.",
      riskLevel: "low",
      needsApproval: false,
    },
    {
      id: "s2",
      title: "Gateway step two: verify the two lines",
      rationale: "A second seat checks the summary.",
      agentRole: "engineer",
      dependsOn: ["s1"],
      expectedOutput: "A verified two-line summary.",
      riskLevel: "low",
      needsApproval: false,
    },
    {
      id: "s3",
      title: "Gateway step three: surface the summary",
      rationale: "Surface the result.",
      agentRole: "ceo",
      dependsOn: ["s2"],
      expectedOutput: "The final two-line summary.",
      riskLevel: "low",
      needsApproval: false,
    },
  ],
  successCriteria: ["Two lines summarise the brief."],
  blockers: [],
};

type FakeGatewayOptions = {
  /** Throw this message on the planner call. */
  failPlanner?: string;
  /** Verdict per critic call, in order; the last one repeats. */
  critiques?: Array<{ verdict: string; reason: string; improvement?: string }>;
  consolidation?: string;
  /** Simulates offline mode: no configured provider at all. */
  offline?: boolean;
};

function fakeGateway(calls: RecordedCall[], options: FakeGatewayOptions = {}): ModelGateway {
  let criticCalls = 0;
  const completion = (text: string): GatewayCompletion => ({
    text,
    provider: "google",
    model: CONFIG_MODEL,
    modelTier: "sonnet",
    inputTokens: 100,
    outputTokens: 50,
    costCents: 1,
    estimated: true,
    finishReason: "stop",
  });
  async function complete(req: GatewayStreamRequest): Promise<GatewayCompletion> {
    const system = req.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
    const user = req.messages.filter((m) => m.role === "user").map((m) => m.content).join("\n");
    const kind = classify(system);
    calls.push({ kind, role: req.role, system, user });
    if (options.offline) throw new Error("model gateway: no configured provider in the chain [google]");
    switch (kind) {
      case "planner":
        if (options.failPlanner) throw new Error(options.failPlanner);
        // Gemini-style: fenced JSON with a lead-in sentence, which the port must tolerate.
        return completion("Here is the plan:\n```json\n" + JSON.stringify(GATEWAY_PLAN) + "\n```");
      case "critic": {
        const list = options.critiques ?? [{ verdict: "pass", reason: "gateway critic: sufficient." }];
        const verdict = list[Math.min(criticCalls, list.length - 1)]!;
        criticCalls += 1;
        return completion(JSON.stringify(verdict));
      }
      case "consolidator":
        return completion(options.consolidation ?? "TL;DR — gateway consolidation of the step outputs.");
      default:
        return completion(JSON.stringify({ reply: "ok", suggestions: [] }));
    }
  }
  return {
    complete,
    // eslint-disable-next-line require-yield
    stream: async function* () {
      throw new Error("fake gateway: stream is not used by the ports");
    },
    resolveRoute: () => ({
      providers: options.offline ? [] : ["google"],
      fallbackChain: ["google"],
      modelTier: "sonnet",
      explicitModel: CONFIG_MODEL,
      modelForProvider: () => CONFIG_MODEL,
    }),
    configuredProviders: () => (options.offline ? [] : ["google"]),
    estimateCostCents: () => 0,
  };
}

function finalTurn(summary: string): SeatChatResponse {
  return {
    choices: [{ message: { content: JSON.stringify({ toolCall: null, summary, findings: [], recommendations: [], workRequests: [] }) } }],
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
  };
}

function userPrompt(request: SeatChatRequest): string {
  return request.messages.filter((m) => m.role === "user").map((m) => m.content).join("\n");
}

async function newCompany(name: string): Promise<string> {
  const { store } = await import("@/lib/store");
  const company = await store.createCompany({ name, brief: { vision: "provider port regression" } });
  return company.id;
}

async function collect(handle: AsyncIterable<OrcEvent> & { result(): Promise<OrchestrationRunSnapshot> }) {
  const events: OrcEvent[] = [];
  for await (const event of handle) events.push(event);
  return { events, snapshot: await handle.result() };
}

describe("planner, critic and consolidator reach the configured provider through the gateway", () => {
  let createOrchestrator: typeof import("./index.js").createOrchestrator;

  beforeAll(async () => {
    imitateFreshInstall();
    createOrchestrator = (await import("./index.js")).createOrchestrator;
  });
  afterAll(restoreEnv);

  it("the plan comes from the gateway, not the deterministic fallback, and every phase is a provider call", async () => {
    const calls: RecordedCall[] = [];
    const seatPrompts: string[] = [];
    const orchestrator = createOrchestrator({
      model: { provider: "google", model: CONFIG_MODEL },
      gateway: fakeGateway(calls),
      createChatCompletion: async (request) => {
        seatPrompts.push(userPrompt(request));
        return finalTurn("Two lines: the brief, summarised.");
      },
    });
    const companyId = await newCompany("ports — plan from gateway");
    const { events, snapshot } = await collect(orchestrator.run({ companyId, objective: OBJECTIVE }));

    expect(snapshot.status).toBe("completed");
    const { FALLBACK_PLAN_REASONING } = await import("./types.js");
    expect(snapshot.plan?.reasoning).toBe(GATEWAY_PLAN.reasoning);
    expect(snapshot.plan?.reasoning).not.toBe(FALLBACK_PLAN_REASONING);
    const titles = snapshot.plan?.steps.map((step) => step.title) ?? [];
    for (const step of GATEWAY_PLAN.steps) expect(titles).toContain(step.title);
    expect(snapshot.steps).toHaveLength(3);

    const planner = calls.filter((call) => call.kind === "planner");
    expect(planner).toHaveLength(1);
    expect(planner[0]!.user).toContain(OBJECTIVE);

    // Before the fix a 3-step run made 4 provider calls (the seats only). Now:
    // planner + 3 seats + 3 critiques + consolidation = 8.
    const critics = calls.filter((call) => call.kind === "critic");
    expect(critics).toHaveLength(3);
    for (const critic of critics) expect(critic.user).toMatch(/^Step: Gateway step/m);
    const consolidations = calls.filter((call) => call.kind === "consolidator");
    expect(consolidations).toHaveLength(1);
    expect(seatPrompts).toHaveLength(3);
    const providerCalls = planner.length + seatPrompts.length + critics.length + consolidations.length;
    expect(providerCalls).toBe(8);

    // The critic verdict on every step is the gateway's, not the auto-pass.
    const critiqued = snapshot.steps as ReadonlyArray<{ critique?: { verdict: string; reason: string } }>;
    for (const step of critiqued) {
      expect(step.critique?.verdict).toBe("pass");
      expect(step.critique?.reason).toBe("gateway critic: sufficient.");
    }
    for (const event of events.filter((e) => e.kind === "step_critic")) {
      expect(JSON.stringify(event.step)).not.toContain("supervisor offline");
    }
  }, 60_000);

  it("the critic's verdict drives execution: a gateway 'retry' re-executes the step with the improvement", async () => {
    const calls: RecordedCall[] = [];
    const seatPrompts: string[] = [];
    const orchestrator = createOrchestrator({
      model: { provider: "google", model: CONFIG_MODEL },
      gateway: fakeGateway(calls, {
        critiques: [
          { verdict: "retry", reason: "gateway critic: missing the second line.", improvement: "GATEWAY-IMPROVEMENT: add the second line" },
          { verdict: "pass", reason: "gateway critic: both lines present." },
        ],
      }),
      createChatCompletion: async (request) => {
        seatPrompts.push(userPrompt(request));
        return finalTurn("Two lines: the brief, summarised.");
      },
    });
    const companyId = await newCompany("ports — critic retry");
    const { snapshot } = await collect(orchestrator.run({ companyId, objective: OBJECTIVE }));

    expect(snapshot.status).toBe("completed");
    // 3 steps, the first retried once: 4 seat executions and 4 critiques.
    expect(seatPrompts).toHaveLength(4);
    expect(calls.filter((call) => call.kind === "critic")).toHaveLength(4);
    expect(seatPrompts.some((prompt) => prompt.includes("GATEWAY-IMPROVEMENT: add the second line"))).toBe(true);
    const first = snapshot.steps[0] as { critique?: { verdict: string; reason: string } };
    expect(first.critique?.verdict).toBe("pass");
    expect(first.critique?.reason).toBe("gateway critic: both lines present.");
  }, 60_000);

  it("the consolidated summary is the gateway's, not the literal fallback, in the snapshot and on the events", async () => {
    const calls: RecordedCall[] = [];
    const orchestrator = createOrchestrator({
      model: { provider: "google", model: CONFIG_MODEL },
      gateway: fakeGateway(calls, { consolidation: "TL;DR — the brief in two lines, consolidated by the gateway." }),
      createChatCompletion: async () => finalTurn("Two lines: the brief, summarised."),
    });
    const companyId = await newCompany("ports — consolidation");
    const { events, snapshot } = await collect(orchestrator.run({ companyId, objective: OBJECTIVE }));

    expect(snapshot.status).toBe("completed");
    expect(snapshot.summary).not.toBe(FALLBACK_SUMMARY);
    expect(snapshot.summary).toContain("consolidated by the gateway");
    const consolidation = calls.find((call) => call.kind === "consolidator");
    expect(consolidation).toBeDefined();
    expect(consolidation!.user).toContain("Two lines: the brief, summarised.");

    const end = events.find((event) => event.kind === "consolidate_end");
    expect(end?.run?.summary).toContain("consolidated by the gateway");
    expect(end?.detail ?? "").toMatch(/wrapper consolidated/i);
    const done = events.find((event) => event.kind === "run_done");
    expect(done?.run?.summary).toContain("consolidated by the gateway");
    expect((await orchestrator.snapshot(snapshot.id))?.summary).toContain("consolidated by the gateway");
  }, 60_000);

  it("a planner failure with a provider configured fails the run with the provider's message — no canned plan", async () => {
    const calls: RecordedCall[] = [];
    const seatPrompts: string[] = [];
    const orchestrator = createOrchestrator({
      model: { provider: "google", model: CONFIG_MODEL },
      gateway: fakeGateway(calls, { failPlanner: "429 RESOURCE_EXHAUSTED: quota exceeded for gemini-3.5-flash-lite" }),
      createChatCompletion: async (request) => {
        seatPrompts.push(userPrompt(request));
        return finalTurn("should never run");
      },
    });
    const companyId = await newCompany("ports — planner failure");
    const { events, snapshot } = await collect(orchestrator.run({ companyId, objective: OBJECTIVE }));

    expect(snapshot.status).toBe("failed");
    expect(snapshot.summary ?? "").toContain("429 RESOURCE_EXHAUSTED");
    expect(snapshot.summary ?? "").toMatch(/planner/i);
    const kinds = events.map((event) => event.kind);
    expect(kinds).toContain("run_failed");
    expect(kinds).not.toContain("run_done");
    expect(events.find((event) => event.kind === "run_failed")?.detail ?? "").toContain("429 RESOURCE_EXHAUSTED");
    // No seat ran on the canned plan.
    expect(seatPrompts).toHaveLength(0);
    expect((await orchestrator.snapshot(snapshot.id))?.status).toBe("failed");
  }, 60_000);

  it("offline (no provider configured at all) keeps the deterministic fallback and completes", async () => {
    const calls: RecordedCall[] = [];
    const orchestrator = createOrchestrator({
      model: { provider: "google", model: CONFIG_MODEL },
      gateway: fakeGateway(calls, { offline: true }),
      createChatCompletion: async () => finalTurn("offline seat answer"),
    });
    const companyId = await newCompany("ports — offline");
    const { snapshot } = await collect(orchestrator.run({ companyId, objective: OBJECTIVE }));
    const { FALLBACK_PLAN_REASONING } = await import("./types.js");
    expect(snapshot.status).toBe("completed");
    expect(snapshot.plan?.reasoning).toBe(FALLBACK_PLAN_REASONING);
    expect(snapshot.summary).toBe(FALLBACK_SUMMARY);
  }, 60_000);
});
