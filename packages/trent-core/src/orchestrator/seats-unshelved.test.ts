/**
 * B1 — the nine seats can all run, and the CLI's roster is the execution roster.
 *
 * Two independent failures were recorded by the 2026-09-18 fleet audit (§1.1, §1.2):
 *   - `apps/web/lib/orchestrator-runtime.ts` remapped analyst/finance/escalation to ceo and
 *     sales to growth at the single plan chokepoint, so four seats could never run a step;
 *   - the CLI's `CORE_ROLES` listed a `browser` seat that has no execution role and omitted
 *     `sales`, which does, so the two rosters disagreed by one member each way.
 *
 * The first test pins the rosters together so they cannot drift again. The second drives the
 * wrapper's own orchestrator with a fake model whose plan names the four formerly shelved
 * seats and asserts the emitted events carry those seats, not their old owners.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CORE_ROLE_IDS } from "../fleet/AgentInstaller.js";
import { SEAT_ROLES } from "./seat-wiring.js";
import type { OrcEvent } from "./types.js";

/** The seats this run plans a step for: every seat the 2026-07-01 shrink made unreachable. */
const UNSHELVED = ["analyst", "finance", "escalation", "sales"] as const;

describe("fleet roster", () => {
  it("lists exactly the seats the orchestrator can assign a step to", () => {
    expect([...CORE_ROLE_IDS].sort()).toEqual([...SEAT_ROLES].sort());
  });

  it("holds a seat for every formerly shelved role", () => {
    for (const role of UNSHELVED) expect(CORE_ROLE_IDS).toContain(role);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Wrapper-side proof: a real run, a fake model, no live provider.
// The offline boot is the proven pattern from `orchestrator.test.ts`.
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

function imitateCompiledBinary(): void {
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

/** The objective is deliberately neutral so the planner prompt's route hint adds no step. */
const OBJECTIVE = "Prepare the quarterly operating review for the founder.";

/** One step per formerly shelved seat, all independent, none needing approval. */
function fakePlan(): string {
  return JSON.stringify({
    objective: OBJECTIVE,
    reasoning: "one step per specialist seat",
    steps: UNSHELVED.map((role, index) => ({
      id: `s${index + 1}`,
      title: `${role} prepares its part of the review`,
      rationale: `the ${role} seat owns this part`,
      agentRole: role,
      dependsOn: [],
      expectedOutput: `${role} section of the review`,
      riskLevel: "low",
      needsApproval: false,
      spec: { acceptance: [`${role} section exists`], inputsFrom: [] },
    })),
    successCriteria: ["Every seat delivered its own section"],
    blockers: [],
  });
}

describe("a run assigns its steps to the seats the plan named", () => {
  let events: OrcEvent[] = [];
  let plannedRoles: string[] = [];

  beforeAll(async () => {
    imitateCompiledBinary();

    const { applyStandaloneEnv, IN_MEMORY_DATABASE } = await import("../runtime/env.js");
    applyStandaloneEnv(IN_MEMORY_DATABASE);

    const { store } = await import("@/lib/store");
    const { createEvalExecuteSeatModel, createEvalMockCompletion } = await import("@/lib/eval-mock-providers");
    const { setSemanticRouterEmbedderForTests } = await import("@/lib/semantic-router");

    setSemanticRouterEmbedderForTests(async (texts: string[]) => texts.map(() => Array(384).fill(0.1)));

    const company = await store.createCompany({
      name: "SeatsUnshelved",
      brief: { vision: "every seat runs its own step" },
    });

    // The eval mock answers the critic and every seat call; only the planner's reply is
    // replaced, and it is recognised by its shape (a plan is the one reply carrying `steps`)
    // rather than by matching prompt text.
    const evalCompletion = createEvalMockCompletion({});
    const createCompletion = (async (...args: unknown[]) => {
      const reply = (await (evalCompletion as (...a: unknown[]) => Promise<{ content: string; totalTokens: number }>)(
        ...args,
      ));
      const parsed = JSON.parse(reply.content) as { steps?: unknown };
      if (!Array.isArray(parsed.steps)) return reply;
      return { ...reply, content: fakePlan() };
    }) as unknown as (...args: never[]) => unknown;

    const { createOrchestrator } = await import("./index.js");
    const orchestrator = createOrchestrator({
      createCompletion,
      executeSeatModelFn: createEvalExecuteSeatModel() as unknown as (...args: never[]) => unknown,
    });

    const handle = orchestrator.run({ companyId: company.id, objective: OBJECTIVE });
    const result = handle.result();
    for await (const event of handle) events.push(event);
    const snapshot = await result;
    plannedRoles = snapshot.steps.map((step) => step.agentRole);
  }, 180_000);

  afterAll(() => {
    restoreEnv();
  });

  it("keeps every planned seat in the run's steps", () => {
    expect(plannedRoles).toEqual([...UNSHELVED]);
  });

  it("emits a start event carrying the seat the plan named, for each of them", () => {
    const started = events
      .filter((event) => event.kind === "step_start")
      .map((event) => event.step?.agentRole);
    for (const role of UNSHELVED) expect(started).toContain(role);
  });

  it("never remaps a seat to its old owner", () => {
    const seats = new Set(
      events.flatMap((event) => (event.step?.agentRole ? [event.step.agentRole] : [])),
    );
    expect([...seats].sort()).toEqual([...UNSHELVED].sort());
  });
});
