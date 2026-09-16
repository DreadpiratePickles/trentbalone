/**
 * `ask_human` through the REAL orchestrator: a seat asks, the run parks on the app's own approval
 * gate, `answer(runId, stepId, text)` releases it, and the seat's next turn sees the founder's text
 * as the tool result. A step that runs as a delegated child gets `blocked` instead of parking.
 * The planner, critic and seat model are scripted (no provider); the wrapper, the seam, the seat
 * loop and the adapter are real.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OrcEvent, Orchestrator, OrchestrationRunSnapshot } from "./types.js";

const ENV_KEYS = ["NODE_ENV", "DATABASE_URL", "REDIS_URL", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN",
  "TRENT_QUEUE_FALLBACK", "TRENT_EVAL_SYNC_QUEUE", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"] as const;
const savedEnv: Record<string, string | undefined> = {};

type ToolCall = { adapter: string; action: string; status: string; summary: string };
type SeatInput = {
  subtask: { id: string; seat: string; objective: string };
  toolLoopContext?: { step: number; toolHistory: Array<{ adapter: string; action: string; result: ToolCall }> };
};
type StepWithTools = OrchestrationRunSnapshot["steps"][number] & { toolCalls?: ToolCall[] };

const QUESTION = "Ship the EU launch first or the US launch first?";
const ANSWER = "EU first; the US launch waits for the SOC 2 letter.";
const ASK = `ask_human ${JSON.stringify({ question: QUESTION, context: "Both launches are ready.", options: ["EU", "US"] })}`;

function scriptedPlanner(objective: string, title: string) {
  return async (_model: string, messages: Array<{ role: string; content: string }>) => {
    const system = messages.find((m) => m.role === "system")?.content ?? "";
    const user = messages.find((m) => m.role === "user")?.content ?? "";
    if (system.includes("quality supervisor")) return { content: JSON.stringify({ verdict: "pass", reason: "scripted" }), totalTokens: 4 };
    if (system.includes("chief orchestrator") || system.includes("orchestration planner") || user.includes("Objective:")) {
      return {
        content: JSON.stringify({
          objective,
          reasoning: "scripted plan: one step that must ask the founder",
          steps: [{ id: "s1", title, rationale: "the objective", agentRole: "ceo", dependsOn: [], expectedOutput: "The founder's decision, quoted", riskLevel: "low", needsApproval: false }],
          successCriteria: ["decision quoted"],
          blockers: [],
        }),
        totalTokens: 12,
      };
    }
    return { content: JSON.stringify({ summary: "scripted consolidation", findings: [], recommendations: [], workRequests: [] }), totalTokens: 4 };
  };
}

/** The scripted seat: ask on turn 1, then answer from the tool result. */
function scriptedSeat(seatInputs: SeatInput[]) {
  return (async (input: SeatInput) => {
    seatInputs.push(input);
    const loop = input.toolLoopContext;
    const reply = (output: unknown) => ({ output, model: "scripted-seat", tokens: 10, costCents: 0, fallback: false });
    const human = loop?.toolHistory.find((t) => t.adapter === "human")?.result;
    if (!human) return reply({ toolCall: { name: "human", action: ASK }, summary: null });
    return reply({ toolCall: null, summary: `The founder said: ${human.summary}`, findings: [], recommendations: [], riskNotes: [], whatIDidNotDo: [], workRequests: [] });
  }) as unknown as (...args: never[]) => unknown;
}

describe("ask_human parks a run and answer() resumes it", () => {
  let orchestrator: Orchestrator;
  const seatInputs: SeatInput[] = [];
  let cleanup: () => Promise<void> = async () => undefined;

  beforeAll(async () => {
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    process.env.NODE_ENV = "production";
    const { buildTrentToolAdapters, HumanAnswers } = await import("../tools/index.js");
    const answers = new HumanAnswers();
    const tools = buildTrentToolAdapters({ toolsets: ["human"], disabled_toolsets: [] }, { workspace: process.cwd(), profileDir: process.cwd(), backend: "local", humanAnswers: answers });
    cleanup = async () => { for (const tool of tools) await tool.cleanup(); };
    const { createOrchestrator } = await import("./index.js");
    const objective = "decide which launch goes first";
    orchestrator = createOrchestrator({
      tools,
      humanAnswers: answers,
      createCompletion: scriptedPlanner(objective, "Ask the founder which launch goes first") as unknown as (...args: never[]) => unknown,
      executeSeatModelFn: scriptedSeat(seatInputs),
    });
  }, 120_000);

  afterAll(async () => {
    await cleanup();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("the gate carries the question, answer() releases the step, and the seat's next turn sees the text", async () => {
    const { questionFromEvent } = await import("../tools/human/index.js");
    const companyId = await orchestrator.ensureCompany({ name: "ask_human run", vision: "founder decisions" });
    const handle = orchestrator.run({ companyId, objective: "decide which launch goes first" });
    const events: OrcEvent[] = [];
    let asked: { stepId: string; question: string; released: boolean } | undefined;
    for await (const event of handle) {
      events.push(event);
      if (event.kind === "run_awaiting_approval" && asked === undefined && event.step?.id) {
        const question = questionFromEvent(event);
        expect(question?.question).toBe(QUESTION);
        expect(question?.options).toEqual(["EU", "US"]);
        const released = await orchestrator.answer!(event.runId, event.step.id, ANSWER);
        asked = { stepId: event.step.id, question: question?.question ?? "", released };
      }
    }
    const snapshot = await handle.result();

    expect(asked?.released).toBe(true);
    expect(snapshot.status).toBe("completed");
    const kinds = events.map((e) => e.kind);
    expect(kinds.lastIndexOf("run_done")).toBeGreaterThan(kinds.indexOf("run_awaiting_approval"));
    const step = snapshot.steps.find((s) => s.id === asked?.stepId) as StepWithTools | undefined;
    expect(step?.status).toBe("completed");
    expect(step?.output).toContain(ANSWER);
    // The app appends its own platform_readiness record after the seat's calls; only the human calls are ours.
    const calls = (step?.toolCalls ?? []).filter((c) => c.adapter === "human");
    expect(calls.map((c) => [c.adapter, c.status])).toEqual([["human", "completed"]]);
    expect(calls[0]?.summary).toBe(ANSWER);
    // The replay ran the tool once and then the seat saw it: no third ask.
    expect(seatInputs.filter((i) => i.toolLoopContext?.toolHistory.some((t) => t.adapter === "human"))).toHaveLength(1);
  }, 120_000);
});

describe("ask_human in a delegated child step", () => {
  let orchestrator: Orchestrator;
  let cleanup: () => Promise<void> = async () => undefined;

  beforeAll(async () => {
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    process.env.NODE_ENV = "production";
    const { buildTrentToolAdapters, HumanAnswers } = await import("../tools/index.js");
    const tools = buildTrentToolAdapters({ toolsets: ["human"], disabled_toolsets: [] }, { workspace: process.cwd(), profileDir: process.cwd(), backend: "local", humanAnswers: new HumanAnswers() });
    cleanup = async () => { for (const tool of tools) await tool.cleanup(); };
    const { createOrchestrator } = await import("./index.js");
    const objective = "decide which launch goes first";
    // A step titled the way the app titles delegated children: the seat's objective starts with `[delegated]`.
    orchestrator = createOrchestrator({
      tools,
      createCompletion: scriptedPlanner(objective, "[delegated] Ask the founder which launch goes first") as unknown as (...args: never[]) => unknown,
      executeSeatModelFn: scriptedSeat([]),
    });
  }, 120_000);

  afterAll(async () => {
    await cleanup();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("gets blocked with a one-line reason and the run never parks", async () => {
    const companyId = await orchestrator.ensureCompany({ name: "ask_human child", vision: "founder decisions" });
    const handle = orchestrator.run({ companyId, objective: "decide which launch goes first" });
    const kinds: string[] = [];
    for await (const event of handle) kinds.push(event.kind);
    const snapshot = await handle.result();
    expect(kinds).not.toContain("run_awaiting_approval");
    const step = snapshot.steps[0] as StepWithTools | undefined;
    const human = (step?.toolCalls ?? []).find((c) => c.adapter === "human");
    expect(human?.status).toBe("blocked");
    expect(human?.summary).toMatch(/delegated child cannot wait/);
  }, 120_000);
});
