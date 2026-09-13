import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type {
  OrcEvent,
  Orchestrator,
  OrchestrationRunSnapshot,
  OrchestrationStepSnapshot,
  SeatChatRequest,
  SeatChatResponse,
} from "./types.js";

/**
 * The four defects the live proof exposed (04_verification/output/live-agents-and-tools.md, §4),
 * pinned offline against the REAL orchestrator with an injected seat provider — no mock providers
 * from apps/web, so the wrapper's own env mapping, failure detection, approval resume and tool-name
 * normaliser are what is under test.
 *
 * Every provider here is a fake handed to `createOrchestrator({ createChatCompletion })`, which the
 * wrapper threads into the real `executeSeatModel` — so model resolution, the fallback chain and the
 * seat loop all run for real; only the HTTP call is replaced.
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
] as const;

const savedEnv: Record<string, string | undefined> = {};

/** A fresh install with a config file and nothing else: no keys, no model pins, production mode. */
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

function finalTurn(summary: string): SeatChatResponse {
  return {
    choices: [{ message: { content: JSON.stringify({ toolCall: null, summary, findings: [], recommendations: [], workRequests: [] }) } }],
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
  };
}

function toolTurn(name: string, action: string): SeatChatResponse {
  return {
    choices: [{ message: { content: JSON.stringify({ toolCall: { name, action }, summary: null }) } }],
    usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
  };
}

function userPrompt(request: SeatChatRequest): string {
  return request.messages.filter((m) => m.role === "user").map((m) => m.content).join("\n");
}

async function newCompany(name: string): Promise<string> {
  const { store } = await import("@/lib/store");
  const company = await store.createCompany({ name, brief: { vision: "defect regression" } });
  return company.id;
}

async function collect(handle: AsyncIterable<OrcEvent> & { result(): Promise<OrchestrationRunSnapshot> }) {
  const events: OrcEvent[] = [];
  for await (const event of handle) events.push(event);
  return { events, snapshot: await handle.result() };
}

describe("D1 — the configured model reaches the seats, and a run whose every model call fails is a failure", () => {
  let orchestratorFactory: typeof import("./index.js").createOrchestrator;

  beforeAll(async () => {
    imitateFreshInstall();
    orchestratorFactory = (await import("./index.js")).createOrchestrator;
  });
  afterAll(restoreEnv);

  it("maps config.provider/model into the env the orchestrator reads, so every seat call names the configured model", async () => {
    const seen: string[] = [];
    const orchestrator = orchestratorFactory({
      model: { provider: "google", model: CONFIG_MODEL },
      createChatCompletion: async (request) => {
        seen.push(request.model);
        return finalTurn("scoped and done");
      },
    });
    expect(process.env.MODEL_PREFERRED_PROVIDER).toBe("google");
    expect(process.env.GOOGLE_MODEL_DEFAULT).toBe(CONFIG_MODEL);

    const companyId = await newCompany("D1 model mapping");
    const { snapshot } = await collect(orchestrator.run({ companyId, objective: "Summarise the operating brief in two lines." }));

    expect(snapshot.status).toBe("completed");
    expect(seen.length).toBeGreaterThan(0);
    expect(new Set(seen)).toEqual(new Set([CONFIG_MODEL]));
    for (const step of snapshot.steps) expect(step.model).toBe(CONFIG_MODEL);
  }, 60_000);

  it("ends the run as failed with the provider's message when every seat call 404s, and never emits run_done", async () => {
    const orchestrator = orchestratorFactory({
      model: { provider: "google", model: CONFIG_MODEL },
      createChatCompletion: async () => {
        throw new Error("404 status code (no body)");
      },
    });
    const companyId = await newCompany("D1 provider failure");
    const { events, snapshot } = await collect(orchestrator.run({ companyId, objective: "Summarise the operating brief in two lines." }));

    expect(snapshot.status).toBe("failed");
    expect(snapshot.summary ?? "").toContain("404 status code (no body)");
    const kinds = events.map((event) => event.kind);
    expect(kinds).toContain("run_failed");
    expect(kinds).not.toContain("run_done");
    const failed = events.find((event) => event.kind === "run_failed");
    expect(failed?.detail ?? "").toContain("404 status code (no body)");
    const stepEnds = events.filter((event) => event.kind === "step_end");
    expect(stepEnds.length).toBeGreaterThan(0);
    for (const end of stepEnds) expect(end.step?.status).toBe("failed");
    // The persisted snapshot agrees with the stream.
    expect((await orchestrator.snapshot(snapshot.id))?.status).toBe("failed");
  }, 60_000);
});

describe("D2 — the handle streams run_start and stays open across an approval so approve() resumes the run", () => {
  let orchestrator: Orchestrator;

  beforeAll(async () => {
    imitateFreshInstall();
    const { createOrchestrator } = await import("./index.js");
    orchestrator = createOrchestrator({
      model: { provider: "google", model: CONFIG_MODEL },
      createChatCompletion: async () => finalTurn("done"),
    });
  });
  afterAll(restoreEnv);

  it("emits run_start first, carrying the run id", async () => {
    const companyId = await newCompany("D2 run_start");
    const { events, snapshot } = await collect(orchestrator.run({ companyId, objective: "Summarise the operating brief." }));
    expect(events[0]?.kind).toBe("run_start");
    expect(events[0]?.runId).toBe(snapshot.id);
    expect(events[0]?.run?.objective).toBe("Summarise the operating brief.");
  }, 60_000);

  it("approve(runId, stepId) while parked resumes the drain loop and the run completes", async () => {
    const companyId = await newCompany("D2 approve");
    // "send" makes the deterministic fallback planner gate s2 (see D4).
    const handle = orchestrator.run({ companyId, objective: "Draft and send the weekly investor update." });
    const events: OrcEvent[] = [];
    let approved: { runId: string; stepId: string; ok: boolean } | undefined;
    for await (const event of handle) {
      events.push(event);
      if (event.kind === "run_awaiting_approval" && approved === undefined) {
        const stepId = event.step?.id!;
        approved = { runId: event.runId, stepId, ok: await orchestrator.approve(event.runId, stepId) };
      }
    }
    const snapshot = await handle.result();

    expect(approved?.ok).toBe(true);
    expect(approved?.runId).toBe(snapshot.id);
    const kinds = events.map((event) => event.kind);
    expect(kinds.indexOf("run_awaiting_approval")).toBeGreaterThan(-1);
    expect(kinds.lastIndexOf("run_done")).toBeGreaterThan(kinds.indexOf("run_awaiting_approval"));
    expect(snapshot.status).toBe("completed");
    expect(snapshot.steps.find((step) => step.id === approved?.stepId)?.status).toBe("completed");
  }, 60_000);

  it("reject(runId, stepId) while parked also resumes, and the run terminates", async () => {
    const companyId = await newCompany("D2 reject");
    const handle = orchestrator.run({ companyId, objective: "Draft and send the weekly investor update." });
    let rejected = false;
    const kinds: string[] = [];
    for await (const event of handle) {
      kinds.push(event.kind);
      if (event.kind === "run_awaiting_approval" && !rejected) {
        rejected = await orchestrator.reject(event.runId, event.step?.id!);
      }
    }
    const snapshot = await handle.result();
    expect(rejected).toBe(true);
    expect(["completed", "failed"]).toContain(snapshot.status);
    expect(kinds.some((kind) => kind === "run_done" || kind === "run_failed")).toBe(true);
  }, 60_000);
});

describe("D4 — a fallback-planner gate is surfaced as an answerable gate, with its trigger words documented", () => {
  beforeAll(imitateFreshInstall);
  afterAll(restoreEnv);

  it("documents the trigger words in the wrapper's types and they include 'send'", async () => {
    const { FALLBACK_PLANNER_APPROVAL_TRIGGERS } = await import("./types.js");
    expect(FALLBACK_PLANNER_APPROVAL_TRIGGERS).toContain("send");
    expect(FALLBACK_PLANNER_APPROVAL_TRIGGERS).toContain("delete");
  });

  it("annotates the awaiting-approval events so the REPL can explain the gate", async () => {
    const { createOrchestrator } = await import("./index.js");
    const { FALLBACK_PLANNER_APPROVAL_TRIGGERS } = await import("./types.js");
    const orchestrator = createOrchestrator({
      model: { provider: "google", model: CONFIG_MODEL },
      createChatCompletion: async () => finalTurn("done"),
    });
    const companyId = await newCompany("D4 send gate");
    const handle = orchestrator.run({ companyId, objective: "Draft and send the weekly investor update." });
    let gate: OrcEvent | undefined;
    for await (const event of handle) {
      if (event.kind === "run_awaiting_approval" && gate === undefined) {
        gate = event;
        await orchestrator.reject(event.runId, event.step?.id!);
      }
    }
    await handle.result();

    expect(gate).toBeDefined();
    expect(gate?.step?.id).toBeTypeOf("string");
    expect(gate?.detail ?? "").toMatch(/fallback planner/i);
    expect(gate?.detail ?? "").toContain("send");
    for (const word of FALLBACK_PLANNER_APPROVAL_TRIGGERS) expect(gate?.detail ?? "").toContain(word);
  }, 60_000);
});

describe("ensureCompany — the local session's company exists before the first run", () => {
  beforeAll(imitateFreshInstall);
  afterAll(restoreEnv);

  it("creates the company once and finds it again by slug", async () => {
    const { createOrchestrator } = await import("./index.js");
    const orchestrator = createOrchestrator({ model: { provider: "google", model: CONFIG_MODEL } });
    const first = await orchestrator.ensureCompany({ name: "Trent Local", slug: "trent-local" });
    const second = await orchestrator.ensureCompany({ name: "Trent Local", slug: "trent-local" });
    expect(first).toMatch(/^company_/);
    expect(second).toBe(first);
    const { store } = await import("@/lib/store");
    expect((await store.getCompany(first))?.slug).toBe("trent-local");
  });
});

describe("tool-name guard — a split {name, action} is normalised to the exact registered adapter", () => {
  beforeAll(imitateFreshInstall);
  afterAll(restoreEnv);

  it("maps {name:'memory', action:'read'} to memory:read and the tool actually runs", async () => {
    const { createOrchestrator } = await import("./index.js");
    const orchestrator = createOrchestrator({
      model: { provider: "google", model: CONFIG_MODEL },
      createChatCompletion: async (request) => {
        const prompt = userPrompt(request);
        if (/Prior tool results/.test(prompt) && /memory:read\(/.test(prompt)) return finalTurn("The count came from memory:read.");
        // The split form the live model actually sent — only to a seat that is offered memory:read.
        if (/Tool-use step 1 of/.test(prompt) && /Available tools:.*\bmemory:read\b/.test(prompt)) return toolTurn("memory", "read");
        return finalTurn("nothing to add");
      },
    });
    const companyId = await newCompany("guard memory read");
    const { snapshot } = await collect(
      orchestrator.run({ companyId, objective: "Report how many memory documents this company has." }),
    );
    const steps = snapshot.steps as ReadonlyArray<
      OrchestrationStepSnapshot & { toolCalls?: Array<{ adapter: string; status: string; summary: string }> }
    >;
    const calls = steps.flatMap((step) => step.toolCalls ?? []);
    const read = calls.find((call) => call.adapter === "memory:read");
    expect(read, JSON.stringify(calls)).toBeDefined();
    expect(read?.status).toBe("completed");
    expect(calls.some((call) => /not allowed for this seat/.test(call.summary))).toBe(false);
  }, 60_000);
});
