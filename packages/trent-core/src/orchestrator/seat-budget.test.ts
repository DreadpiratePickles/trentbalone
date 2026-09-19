/**
 * B2, shortfall 10 — the per-seat budget stops being theatre.
 *
 * `budgetCentsPerRun` was rendered into the seat prompt (`agent-runtime.ts:122`) and set on the
 * subtask (`orchestrator-runtime.ts:1428`) and never once compared to spend: the seat loop
 * accumulates `costCents` (`seat-agent-loop.ts:228`) and caps nothing. The wrapper's seat-guard
 * port is the only place that sees every seat call's cost, so the cap is enforced there.
 *
 * Money is INTEGER CENTS everywhere, in the ledger and in the message.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { seatCapability } from "../fleet/seat-capabilities.js";
import { SeatTally, shapeEvent } from "./seat-guard.js";
import { SeatBudgetLedger, budgetGuard } from "./seat-guard-budget.js";
import type { OrcEvent } from "./types.js";

const ESCALATION_CAP = seatCapability("escalation").budgetCents;

describe("the seat budget ledger", () => {
  it("defaults each seat's cap to the manifest's budgetCentsPerRun, in integer cents", () => {
    const ledger = new SeatBudgetLedger(new SeatTally());
    expect(ledger.capFor("escalation")).toBe(ESCALATION_CAP);
    expect(ledger.capFor("engineer")).toBe(seatCapability("engineer").budgetCents);
    expect(ledger.capFor("engineer")).not.toBe(ledger.capFor("escalation"));
  });

  it("accumulates per seat within one run and breaches only past the cap", () => {
    const ledger = new SeatBudgetLedger(new SeatTally(), () => 100);
    expect(ledger.record("finance", "s1", 60)).toBeUndefined();
    expect(ledger.spent("finance")).toBe(60);
    expect(ledger.record("finance", "s1", 40)).toBeUndefined();
    const breach = ledger.record("finance", "s1", 1);
    expect(breach).toMatchObject({ seat: "finance", stepId: "s1", spentCents: 101, capCents: 100 });
    // A different seat in the same run keeps its own purse.
    expect(ledger.record("engineer", "s2", 90)).toBeUndefined();
  });

  it("names the spend and the cap in integer cents", () => {
    const ledger = new SeatBudgetLedger(new SeatTally(), () => 75);
    const breach = ledger.record("escalation", "s1", 120)!;
    expect(breach.message).toContain("120");
    expect(breach.message).toContain("75");
    expect(breach.message).toContain("escalation");
    expect(breach.message).not.toContain("$");
  });
});

describe("the budget guard aborts the seat loop", () => {
  it("lets the first call through, then refuses every later call for that seat without reaching a model", async () => {
    const tally = new SeatTally();
    const ledger = new SeatBudgetLedger(tally, () => 75);
    const emitted: OrcEvent[] = [];
    let calls = 0;
    const guarded = budgetGuard(
      async () => {
        calls += 1;
        return { output: { toolCall: { name: "terminal", action: "ls" } }, model: "fake", tokens: 10, costCents: 120, fallback: false };
      },
      ledger,
      (event) => emitted.push(event),
    );

    const first = await guarded({ subtask: { id: "s1", seat: "escalation" } });
    expect(calls).toBe(1);
    expect(first.costCents).toBe(120);

    const second = await guarded({ subtask: { id: "s1", seat: "escalation" } });
    expect(calls, "the model must not be called once the cap is broken").toBe(1);
    expect(second.costCents).toBe(0);
    expect(second.error).toContain("120");
    expect(second.error).toContain("75");
    // A refusal is a FINAL turn, so the app's seat loop returns instead of asking again.
    expect((second.output as { summary?: string }).summary).toContain("75");

    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.kind).toBe("step_note");
    expect(emitted[0]?.detail).toContain("120");
    expect(emitted[0]?.detail).toContain("75");
  });

  it("ends the step failed with the spend and the cap, even though the model call itself succeeded", async () => {
    const tally = new SeatTally();
    const ledger = new SeatBudgetLedger(tally, () => 75);
    const guarded = budgetGuard(
      async () => ({ output: { summary: "done" }, model: "fake", tokens: 1, costCents: 120, fallback: false }),
      ledger,
    );
    await guarded({ subtask: { id: "s1", seat: "escalation" } });

    const end: OrcEvent = { kind: "step_end", runId: "r1", at: "2026-09-18T00:00:00.000Z", step: { id: "s1", status: "completed" } };
    const shaped = shapeEvent(end, tally, false)!;
    expect(shaped.step?.status).toBe("failed");
    expect(shaped.detail).toContain("120");
    expect(shaped.detail).toContain("75");
    // The run itself did not fail: one seat overspent, every model call answered.
    expect(tally.runFailure()).toBeUndefined();
    expect(tally.abortedSteps()).toEqual(["s1"]);
  });

  it("leaves a seat with no cap alone", async () => {
    const ledger = new SeatBudgetLedger(new SeatTally(), () => undefined);
    let calls = 0;
    const guarded = budgetGuard(
      async () => {
        calls += 1;
        return { output: { summary: "done" }, model: "fake", tokens: 1, costCents: 10_000, fallback: false };
      },
      ledger,
    );
    await guarded({ subtask: { id: "s1", seat: "engineer" } });
    const again = await guarded({ subtask: { id: "s1", seat: "engineer" } });
    expect(calls).toBe(2);
    expect(again.error).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The whole road: a real run, a fake model that costs more than the seat's cap.
// Offline boot is the proven pattern from `seats-unshelved.test.ts`.
// ─────────────────────────────────────────────────────────────────────────────

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
] as const;
const savedEnv: Record<string, string | undefined> = {};

const OBJECTIVE = "Review the open compliance questions for the founder.";
const CALL_COST_CENTS = ESCALATION_CAP + 45;

function fakePlan(): string {
  return JSON.stringify({
    objective: OBJECTIVE,
    reasoning: "one auditor step",
    steps: [
      {
        id: "s1",
        title: "escalation reviews the compliance questions",
        rationale: "the escalation seat owns risk review",
        agentRole: "escalation",
        dependsOn: [],
        expectedOutput: "risk review",
        riskLevel: "low",
        needsApproval: false,
        spec: { acceptance: ["a review exists"], inputsFrom: [] },
      },
    ],
    successCriteria: ["the review exists"],
    blockers: [],
  });
}

describe("a seat that spends past its cap ends its step failed", () => {
  const events: OrcEvent[] = [];
  let stepStatus: string | undefined;

  beforeAll(async () => {
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    process.env.NODE_ENV = "production";

    const { applyStandaloneEnv, IN_MEMORY_DATABASE } = await import("../runtime/env.js");
    applyStandaloneEnv(IN_MEMORY_DATABASE);
    const { store } = await import("@/lib/store");
    const { createEvalMockCompletion } = await import("@/lib/eval-mock-providers");
    const { setSemanticRouterEmbedderForTests } = await import("@/lib/semantic-router");
    setSemanticRouterEmbedderForTests(async (texts: string[]) => texts.map(() => Array(384).fill(0.1)));

    const company = await store.createCompany({ name: "SeatBudget", brief: { vision: "caps are enforced" } });

    const evalCompletion = createEvalMockCompletion({});
    const createCompletion = (async (...args: unknown[]) => {
      const reply = await (evalCompletion as (...a: unknown[]) => Promise<{ content: string; totalTokens: number }>)(...args);
      const parsed = JSON.parse(reply.content) as { steps?: unknown };
      if (!Array.isArray(parsed.steps)) return reply;
      return { ...reply, content: fakePlan() };
    }) as unknown as (...args: never[]) => unknown;

    // Every seat call answers immediately — and costs more than the escalation seat's whole cap.
    const executeSeatModelFn = (async (input: { subtask: { seat: string } }) => ({
      output: {
        summary: `${input.subtask.seat} reviewed the compliance questions`,
        findings: [],
        recommendations: [],
        riskNotes: [],
        whatIDidNotDo: [],
        workRequests: [],
      },
      model: "fake-model",
      tokens: 100,
      costCents: CALL_COST_CENTS,
      fallback: false,
    })) as unknown as (...args: never[]) => unknown;

    const { createOrchestrator } = await import("./index.js");
    const orchestrator = createOrchestrator({ createCompletion, executeSeatModelFn });
    const handle = orchestrator.run({ companyId: company.id, objective: OBJECTIVE });
    const result = handle.result();
    for await (const event of handle) events.push(event);
    const snapshot = await result;
    stepStatus = snapshot.steps.find((step) => step.agentRole === "escalation")?.status;
  }, 180_000);

  afterAll(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("emits one budget note naming the spend and the cap in cents", () => {
    const notes = events.filter((event) => event.kind === "step_note" && event.detail?.includes("budget"));
    expect(notes.length).toBeGreaterThanOrEqual(1);
    expect(notes[0]?.detail).toContain(String(CALL_COST_CENTS));
    expect(notes[0]?.detail).toContain(String(ESCALATION_CAP));
  });

  it("ends the step failed, in the events and in the snapshot", () => {
    const end = events.filter((event) => event.kind === "step_end").at(-1);
    expect(end?.step?.status).toBe("failed");
    expect(end?.detail).toContain(String(ESCALATION_CAP));
    expect(stepStatus).toBe("failed");
  });
});
