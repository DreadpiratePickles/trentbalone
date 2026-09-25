/**
 * [P2-8] Spend truth, end to end, through the REAL app pipeline with no seat fake.
 *
 * The live proof of 2026-09-25: a keyed `trent run` for a one-line tagline on gemini-3.5-flash-lite
 * reported $0.17 for 13,677 tokens, about ten times the list price. Two causes, both in read-only
 * apps/web: `executeSeatModel` prices every seat call by TIER (`estimateModelCostCents`, sonnet =
 * $3.00 per million input) and rounds each call up to a whole cent, and the planner, critic and
 * consolidator calls never reached the ledger at all.
 *
 * Here the orchestrator is built with only a model gateway (no `executeSeatModelFn`, no
 * `createChatCompletion`), so the wrapper's default seat port answers the app's seat call through
 * that gateway. The gateway reports flash-lite usage; the ledger row and the frames must carry
 * exactly the list price of those tokens.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { currentSpendLedger, installSpendLedger, openSpendLedger } from "../governance/spend-ledger.js";
import type { GatewayCompletion, GatewayStreamRequest, ModelGateway } from "../model-gateway/types.js";
import type { OrcEvent, OrchestrationRunSnapshot } from "./types.js";

const ENV_KEYS = [
  "NODE_ENV", "DATABASE_URL", "REDIS_URL", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN",
  "TRENT_QUEUE_FALLBACK", "TRENT_EVAL_SYNC_QUEUE", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY",
  "GOOGLE_API_KEY", "MISTRAL_API_KEY", "OPENROUTER_API_KEY", "GOOGLE_MODEL_FAST", "GOOGLE_MODEL_DEFAULT",
  "GOOGLE_MODEL_STRONG", "MODEL_PREFERRED_PROVIDER", "MODEL_ALLOWED_PROVIDERS", "CRITIC_RUBRIC_ENABLED",
  "ORCHESTRATION_PLAN_VALIDATOR_ENABLED",
] as const;
const savedEnv: Record<string, string | undefined> = {};

const FLASH_LITE = "gemini-3.5-flash-lite";
const OBJECTIVE = "Write a one-line tagline for a neighbourhood bakery that opens at 6 am";

const PLAN = {
  objective: OBJECTIVE,
  reasoning: "One seat writes the tagline.",
  steps: [
    {
      id: "s1",
      title: "Write the bakery tagline",
      rationale: "The founder asked for one line.",
      agentRole: "ceo",
      dependsOn: [],
      expectedOutput: "One tagline.",
      riskLevel: "low",
      needsApproval: false,
    },
  ],
  successCriteria: ["One line."],
  blockers: [],
};

type Kind = "seat" | "planner" | "critic" | "consolidator" | "other";

/** Token usage per call kind, and the list price each one works out to on flash-lite. */
const USAGE: Record<Kind, { inputTokens: number; outputTokens: number }> = {
  seat: { inputTokens: 40_000, outputTokens: 7_000 }, // 1.2 + 1.75 = 2.95 cents -> 3
  planner: { inputTokens: 5_000, outputTokens: 1_000 }, // 0.40 of a cent
  critic: { inputTokens: 2_000, outputTokens: 100 }, // 0.085
  consolidator: { inputTokens: 3_000, outputTokens: 500 }, // 0.215; the run is 3.65 cents -> 4
  other: { inputTokens: 0, outputTokens: 0 },
};

function kindOf(req: GatewayStreamRequest): Kind {
  // The seat port pins the model the app resolved; the planner/critic/consolidator ports do not.
  if (req.model !== undefined) return "seat";
  const system = req.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
  if (/chief orchestrator|long-horizon planner/i.test(system)) return "planner";
  if (/quality supervisor/i.test(system)) return "critic";
  if (/consolidator/i.test(system)) return "consolidator";
  return "other";
}

function reply(kind: Kind): string {
  switch (kind) {
    case "seat":
      return JSON.stringify({ toolCall: null, summary: "Warm bread from 6 am, baked next door.", findings: [], recommendations: [], workRequests: [] });
    case "planner":
      return JSON.stringify(PLAN);
    case "critic":
      return JSON.stringify({ verdict: "pass", reason: "one line, on brief." });
    case "consolidator":
      return "TL;DR — the tagline is ready.";
    default:
      return "{}";
  }
}

function flashLiteGateway(calls: Kind[], seatModels: string[]): ModelGateway {
  return {
    complete: async (req): Promise<GatewayCompletion> => {
      const kind = kindOf(req);
      calls.push(kind);
      if (kind === "seat") seatModels.push(req.model ?? "");
      return {
        text: reply(kind),
        provider: "google",
        model: FLASH_LITE,
        modelTier: "sonnet",
        ...USAGE[kind],
        cachedInputTokens: 0,
        costCents: 99, // the gateway's per-call figure; the meter prices the tokens itself
        estimated: false,
        priced_as_default: false,
        unpriced: false,
        finishReason: "stop",
      };
    },
    // eslint-disable-next-line require-yield
    stream: async function* () {
      throw new Error("unused");
    },
    resolveRoute: () => ({ providers: ["google"], fallbackChain: ["google"], modelTier: "sonnet", explicitModel: FLASH_LITE, modelForProvider: () => FLASH_LITE }),
    configuredProviders: () => ["google"],
    estimateCostCents: () => 0,
  };
}

async function collect(handle: AsyncIterable<OrcEvent> & { result(): Promise<OrchestrationRunSnapshot> }) {
  const events: OrcEvent[] = [];
  for await (const event of handle) events.push(event);
  return { events, snapshot: await handle.result() };
}

describe("spend truth through the real pipeline", () => {
  let createOrchestrator: typeof import("./index.js").createOrchestrator;
  let profileDir: string;

  beforeAll(async () => {
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    process.env.NODE_ENV = "production";
    createOrchestrator = (await import("./index.js")).createOrchestrator;
  });
  afterAll(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  beforeEach(() => {
    profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-spend-truth-"));
    installSpendLedger(openSpendLedger({ profileDir }));
  });
  afterEach(() => {
    installSpendLedger(undefined);
    fs.rmSync(profileDir, { recursive: true, force: true });
  });

  it("a flash-lite seat of 40,000 in / 7,000 out is a ledger row of exactly 3 cents, and the planner, critic and consolidator have rows", async () => {
    const calls: Kind[] = [];
    const seatModels: string[] = [];
    const orchestrator = createOrchestrator({ model: { provider: "google", model: FLASH_LITE }, gateway: flashLiteGateway(calls, seatModels) });
    const { store } = await import("@/lib/store");
    const company = await store.createCompany({ name: "Spend truth bakery", brief: { vision: "bread at 6 am" } });

    const { events, snapshot } = await collect(orchestrator.run({ companyId: company.id, objective: OBJECTIVE, surface: "run" }));
    expect(snapshot.status, snapshot.summary).toBe("completed");
    // One call of each kind: the seat reached the gateway through the default port, pinned to the
    // model the app resolved for it.
    expect([...calls].sort()).toEqual(["consolidator", "critic", "planner", "seat"]);
    expect(seatModels).toEqual([FLASH_LITE]);

    const rows = currentSpendLedger()?.rows() ?? [];
    const seat = rows.find((row) => row.seat === "ceo");
    // The sonnet tier would have said ceil(40 x 0.3 + 7 x 1.5) = 23 cents.
    expect(seat).toMatchObject({ surface: "run", model: FLASH_LITE, provider: "google", cents: 3, tokens: 47_000, inputTokens: 40_000, outputTokens: 7_000 });
    for (const role of ["planner", "critic", "consolidator"]) {
      expect(rows.find((row) => row.seat === role)).toMatchObject({ model: FLASH_LITE, inputTokens: USAGE[role as Kind].inputTokens });
    }
    const orchestration = rows.filter((row) => ["planner", "critic", "consolidator"].includes(row.seat ?? ""));
    expect(orchestration.reduce((sum, row) => sum + row.cents, 0)).toBe(1);
    const runId = snapshot.id;
    // 2.95 + 0.40 + 0.085 + 0.215 = 3.65 cents of list price, rounded up once.
    expect(currentSpendLedger()?.runTotalCents(runId)).toBe(4);

    // What `trent run` and the REPL ticker add up — step_end plus consolidate_end — is the same 4.
    const framed = events
      .filter((event) => event.kind === "step_end" || event.kind === "consolidate_end")
      .reduce((sum, event) => sum + (event.step?.costCents ?? 0), 0);
    expect(framed).toBe(4);
    expect(events.find((event) => event.kind === "step_end")?.step?.costCents).toBe(3);
  }, 60_000);

  it("the production shape: an injected pass-through executor (the improve loop's skill injector) still reaches the gateway and meters at list price", async () => {
    // `apps/cli/src/commands/improve.ts` `createImproveRunDeps` always hands the orchestrator an
    // `executeSeatModelFn` that wraps the app's REAL `executeSeatModel` and forwards its input. The
    // first live proof after this change still read $0.18 because that dep switched the seat port off.
    const calls: Kind[] = [];
    const seatModels: string[] = [];
    const { loadLibs } = await import("./libs.js");
    const passThrough = async (input: unknown) => (await loadLibs()).gateway.executeSeatModel(input as never);
    const orchestrator = createOrchestrator({
      model: { provider: "google", model: FLASH_LITE },
      gateway: flashLiteGateway(calls, seatModels),
      executeSeatModelFn: passThrough as never,
    });
    const { store } = await import("@/lib/store");
    const company = await store.createCompany({ name: "Spend truth bakery, improve wrapper", brief: { vision: "bread at 6 am" } });

    const { snapshot } = await collect(orchestrator.run({ companyId: company.id, objective: OBJECTIVE, surface: "run" }));
    expect(snapshot.status, snapshot.summary).toBe("completed");
    expect(seatModels).toEqual([FLASH_LITE]);
    const rows = currentSpendLedger()?.rows() ?? [];
    expect(rows.find((row) => row.seat === "ceo")).toMatchObject({ cents: 3, inputTokens: 40_000, outputTokens: 7_000 });
    expect(currentSpendLedger()?.runTotalCents(snapshot.id)).toBe(4);
  }, 60_000);
});
