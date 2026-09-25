/**
 * The closing test for "make sure all the agents share memory": two consecutive runs through the
 * REAL wrapper and pipeline (in-memory store, scripted planner/critic/seat, no provider), and the
 * second run's seat — a different seat — is handed what the first run's seat wrote and produced.
 * Plus the child rule: a delegated step in run 1 reads the shared memory but its write is refused.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OrchestrationRunSnapshot } from "../orchestrator/types.js";

const ENV_KEYS = ["NODE_ENV", "DATABASE_URL", "REDIS_URL", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN",
  "TRENT_QUEUE_FALLBACK", "TRENT_EVAL_SYNC_QUEUE", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"] as const;
const savedEnv: Record<string, string | undefined> = {};

type ToolCall = { adapter: string; action: string; status: string; summary: string };
type StepWithTools = OrchestrationRunSnapshot["steps"][number] & { toolCalls?: ToolCall[] };
type SeatInput = {
  companyId: string;
  subtask: { id: string; seat: string; objective: string };
  systemPrompt?: string;
  dynamicPrompt?: string;
  toolLoopContext?: { step: number; availableTools: string[]; toolHistory: Array<{ adapter: string; action: string; result: ToolCall }> };
};

const RATE_LIMIT_FACT = "The partner API allows 60 requests per minute per key; batch calls above that.";
const ENGINEER_OUTPUT = "Integrated the partner API client with a token bucket at 60 requests per minute and exponential backoff.";

function scriptedPlanner(objective: string, role: string, title: string) {
  return async (_model: string, messages: Array<{ role: string; content: string }>) => {
    const system = messages.find((m) => m.role === "system")?.content ?? "";
    const user = messages.find((m) => m.role === "user")?.content ?? "";
    if (system.includes("quality supervisor")) return { content: JSON.stringify({ verdict: "pass", reason: "scripted" }), totalTokens: 4 };
    if (system.includes("chief orchestrator") || system.includes("orchestration planner") || user.includes("Objective:")) {
      return {
        content: JSON.stringify({
          objective,
          reasoning: "scripted: one step",
          steps: [{ id: "s1", title, rationale: "the objective", agentRole: role, dependsOn: [], expectedOutput: "the result", riskLevel: "low", needsApproval: false }],
          successCriteria: ["done"],
          blockers: [],
        }),
        totalTokens: 12,
      };
    }
    return { content: JSON.stringify({ summary: `scripted consolidation: ${objective}`, findings: [], recommendations: [], workRequests: [] }), totalTokens: 4 };
  };
}

const reply = (output: unknown) => ({ output, model: "scripted-seat", tokens: 10, costCents: 0, fallback: false });
const done = (summary: string, workRequests: unknown[] = []) =>
  reply({ toolCall: null, summary, findings: [], recommendations: [], riskNotes: [], whatIDidNotDo: [], workRequests });

describe("fleet memory through the real wrapper: run 1 (engineer) feeds run 2 (support)", () => {
  const seatInputs: SeatInput[] = [];
  let profileDir = "";
  let first: OrchestrationRunSnapshot;
  let second: OrchestrationRunSnapshot;
  let preludes: Array<string | undefined> = [];
  const stables: Array<string | undefined> = [];

  beforeAll(async () => {
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    process.env.NODE_ENV = "production";
    profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-fleet-orc-"));

    const { applyStandaloneEnv, IN_MEMORY_DATABASE } = await import("../runtime/env.js");
    applyStandaloneEnv(IN_MEMORY_DATABASE);
    const { setSemanticRouterEmbedderForTests } = await import("@/lib/semantic-router");
    // Zero vectors: every embedding score is 0, so capability routing falls back to the regex map.
    setSemanticRouterEmbedderForTests(async (texts: string[]) => texts.map(() => Array(384).fill(0)));

    const { createFleetMemoryHook, createAppFleetSource } = await import("./index.js");
    const { createOrchestrator } = await import("../orchestrator/index.js");
    const fleetMemory = createFleetMemoryHook({ source: createAppFleetSource(), profileDir });

    const seat = (async (input: SeatInput) => {
      seatInputs.push(input);
      const turn = input.toolLoopContext?.step ?? 1;
      const delegated = input.subtask.objective.startsWith("[delegated]");
      if (delegated) {
        // The child tries to write shared memory once, then answers.
        if (turn === 1) return reply({ toolCall: { name: "memory", action: `memory {"target":"memory","action":"add","content":"child note"}` }, summary: null });
        return done("Delegated support note: the customer asked about rate limits.");
      }
      if (input.subtask.seat === "engineer") {
        if (turn === 1) return reply({ toolCall: { name: "memory", action: `memory {"target":"memory","action":"add","content":${JSON.stringify(RATE_LIMIT_FACT)}}` }, summary: null });
        return done(ENGINEER_OUTPUT, [{ capability: "customer support ticket follow-up", input: null }]);
      }
      if (turn === 1) return reply({ toolCall: { name: "fleet_search", action: 'fleet_search {"query":"partner API requests per minute"}' }, summary: null });
      const hit = input.toolLoopContext?.toolHistory.find((t) => t.adapter === "fleet_search")?.result.summary ?? "";
      return done(`Support answer drafted from the fleet: ${hit.slice(0, 400)}`);
    }) as unknown as (...args: never[]) => unknown;

    const objective1 = "integrate the partner API client with rate limiting";
    const orc1 = createOrchestrator({ fleetMemory, createCompletion: scriptedPlanner(objective1, "engineer", "Integrate the partner API") as never, executeSeatModelFn: seat });
    const companyId = await orc1.ensureCompany({ name: "Fleet memory closing test", vision: "shared memory" });
    const h1 = orc1.run({ companyId, objective: objective1 });
    for await (const event of h1) {
      if (event.kind === "run_awaiting_approval" && event.step?.id) await orc1.approve(event.runId, event.step.id);
    }
    first = await h1.result();
    preludes.push(fleetMemory.preludeFor(h1.runId));
    stables.push(fleetMemory.stablePreludeFor(h1.runId));

    const objective2 = "answer the customer's question about partner API rate limits";
    const orc2 = createOrchestrator({ fleetMemory, createCompletion: scriptedPlanner(objective2, "support", "Answer the rate-limit question") as never, executeSeatModelFn: seat });
    const h2 = orc2.run({ companyId, objective: objective2 });
    for await (const event of h2) {
      if (event.kind === "run_awaiting_approval" && event.step?.id) await orc2.approve(event.runId, event.step.id);
    }
    second = await h2.result();
    preludes.push(fleetMemory.preludeFor(h2.runId));
    stables.push(fleetMemory.stablePreludeFor(h2.runId));
  }, 120_000);

  afterAll(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(profileDir, { recursive: true, force: true });
  });

  it("both runs complete", () => {
    expect(first.status, first.summary ?? "").toBe("completed");
    expect(second.status, second.summary ?? "").toBe("completed");
  });

  it("run 1: the engineer's memory write lands on disk, and the run's own prelude did not show it (frozen)", () => {
    const text = fs.readFileSync(path.join(profileDir, "memories", "MEMORY.md"), "utf8");
    expect(text).toContain(RATE_LIMIT_FACT);
    expect(text).not.toContain("child note");
    expect(preludes[0]).toContain("Company memory");
    expect(preludes[0]).not.toContain(RATE_LIMIT_FACT);
  });

  it("run 1: the delegated support child got the shared prelude but its write was blocked", () => {
    const steps = first.steps as StepWithTools[];
    const child = steps.find((s) => s.title.startsWith("[delegated]"));
    expect(child, steps.map((s) => s.title).join(" | ")).toBeDefined();
    const write = child!.toolCalls?.find((c) => c.adapter === "memory");
    expect(write?.status).toBe("blocked");
    const childInput = seatInputs.find((i) => i.subtask.objective.startsWith("[delegated]"));
    // [P2-7] The shared prelude's STABLE tier heads the child's system prompt, the same bytes as run 1's.
    expect(childInput?.systemPrompt?.startsWith(`${stables[0] ?? "<no stable tier>"}\n\n`)).toBe(true);
    expect(childInput?.systemPrompt).toContain("Company memory");
    expect(childInput?.dynamicPrompt ?? "").not.toContain("## Company memory");
  });

  it("run 2: the support seat's prelude carries the engineer's fact and the engineer's step output, within budget", () => {
    const supportInput = seatInputs.find((i) => i.subtask.seat === "support" && !i.subtask.objective.startsWith("[delegated]"));
    expect(supportInput).toBeDefined();
    const system = supportInput!.systemPrompt ?? "";
    const prelude = supportInput!.dynamicPrompt ?? "";
    // The engineer's memory write is company memory: STABLE, so it now heads the system prompt.
    expect(system).toContain(RATE_LIMIT_FACT);
    expect(prelude).toContain("Fleet recall");
    expect(prelude).toContain("[engineer | Integrate the partner API");
    expect(prelude).toContain("token bucket");
    const recall = prelude.slice(prelude.indexOf("## Fleet recall"));
    expect(recall.length).toBeLessThanOrEqual(3000);
    // [P2-7] The run's whole injection, split at the tier boundary: the STABLE tier heads the system
    // prompt and the rest of it ends dynamicPrompt, after the pipeline's own text. Nothing is copied.
    const stable = stables[1] ?? "";
    const rest = (preludes[1] ?? "").slice(stable.length + 2);
    expect(stable).toContain("## Company memory");
    expect(preludes[1]).toBe(`${stable}\n\n${rest}`);
    expect(system.startsWith(`${stable}\n\n`)).toBe(true);
    expect(prelude.endsWith(rest)).toBe(true);
    expect(prelude).not.toContain("## Company memory");
  });

  it("run 2: fleet_search returned the engineer's output tagged [engineer], and the seat's answer used it", () => {
    const steps = second.steps as StepWithTools[];
    const search = steps.flatMap((s) => s.toolCalls ?? []).find((c) => c.adapter === "fleet_search");
    expect(search?.status).toBe("completed");
    expect(search?.summary).toContain("[engineer]");
    expect(search?.summary).toContain("token bucket");
    expect(steps[0]?.output ?? "").toContain("token bucket");
  });
});
