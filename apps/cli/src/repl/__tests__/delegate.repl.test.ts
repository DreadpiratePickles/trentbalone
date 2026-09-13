/**
 * The shipped REPL (`ClassicRepl`) binds a real `DelegatePort`: with the `delegation` toolset on,
 * a seat that calls `delegate_task` gets a `[delegated]` child step in the same run, the child
 * reads shared memory but its write comes back `blocked`, and the parent's next turn sees the
 * child's output. Offline: the real orchestrator and pipeline over the in-memory store, a
 * scripted planner/critic and a scripted seat; no Docker, no proxy, no provider.
 */

import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ConfigManager } from "@trent/core";
import { createTheme } from "../../ui/index.js";
import { createOrchestrator, type OrcEvent, type Orchestrator, type OrchestratorDepsWithImprove } from "@trent/core/orchestrator/index.js";
import { PROMPT } from "../engine.js";
import { ClassicRepl, type ReplDeps } from "../index.js";

const REPO_ROOT = path.resolve(__dirname, "../../../../..");
const ENV_KEYS = [
  "NODE_ENV", "DATABASE_URL", "REDIS_URL", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN",
  "TRENT_QUEUE_FALLBACK", "TRENT_EVAL_SYNC_QUEUE", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY",
  "GOOGLE_API_KEY", "MISTRAL_API_KEY", "OPENROUTER_API_KEY", "GOOGLE_MODEL_FAST", "GOOGLE_MODEL_DEFAULT",
  "GOOGLE_MODEL_STRONG", "MODEL_PREFERRED_PROVIDER", "MODEL_ALLOWED_PROVIDERS",
] as const;
const savedEnv: Record<string, string | undefined> = {};

class ScriptedStdin extends EventEmitter {
  isTTY = true;
  setRawMode(): this {
    return this;
  }
  setEncoding(): this {
    return this;
  }
  resume(): this {
    return this;
  }
  pause(): this {
    return this;
  }
}

let home = "";
const savedHome = process.env.TRENT_HOME;
let profileN = 0;

beforeAll(() => {
  home = mkdtempSync(path.join(os.tmpdir(), "trent-delegate-repl-"));
  process.env.TRENT_HOME = home;
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env.NODE_ENV = "production";
});
afterAll(() => {
  if (savedHome === undefined) delete process.env.TRENT_HOME;
  else process.env.TRENT_HOME = savedHome;
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(home, { recursive: true, force: true });
});

function atPrompt(out: string[]): boolean {
  return out.some((chunk) => chunk === `${PROMPT}\n`);
}

async function until(predicate: () => boolean, ms = 30_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the REPL");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function session(deps: ReplDeps): { repl: ClassicRepl; stdin: ScriptedStdin; out: string[] } {
  profileN += 1;
  const profile = `delegate-${profileN}`;
  const configManager = new ConfigManager({ profile });
  const config = configManager.loadConfig();
  config.terminal.backend = "local";
  config.egress.enabled = false;
  config.toolsets = ["file_ops", "terminal", "delegation"];
  configManager.saveConfig(config);
  const stdin = new ScriptedStdin();
  const out: string[] = [];
  const repl = new ClassicRepl({
    profile,
    io: { write: (text) => void out.push(text), isTTY: false, stdin: stdin as never, exit: vi.fn(), theme: createTheme("none"), width: 80 },
    deps: { workspace: REPO_ROOT, ...deps },
  });
  return { repl, stdin, out };
}

/** A one-step plan for the engineer, a passing critic, a plain consolidation. */
function scriptedPlanner(objective: string) {
  return async (_model: string, messages: Array<{ role: string; content: string }>) => {
    const system = messages.find((m) => m.role === "system")?.content ?? "";
    const user = messages.find((m) => m.role === "user")?.content ?? "";
    if (system.includes("quality supervisor")) return { content: JSON.stringify({ verdict: "pass", reason: "scripted" }), totalTokens: 4 };
    if (system.includes("chief orchestrator") || system.includes("orchestration planner") || user.includes("Objective:")) {
      return {
        content: JSON.stringify({
          objective,
          reasoning: "scripted plan: one engineer step that delegates the support note",
          steps: [{ id: "s1", title: "Integrate the partner API", rationale: "the objective", agentRole: "engineer",
            dependsOn: [], expectedOutput: "the integration plus the support note", riskLevel: "low", needsApproval: false }],
          successCriteria: ["done"],
          blockers: [],
        }),
        totalTokens: 12,
      };
    }
    return { content: JSON.stringify({ summary: "scripted consolidation", findings: [], recommendations: [], workRequests: [] }), totalTokens: 4 };
  };
}

type ToolCall = { adapter: string; action: string; status: string; summary: string };
type SeatInput = {
  subtask: { id: string; seat: string; objective: string };
  dynamicPrompt?: string;
  toolLoopContext?: { step: number; toolHistory: Array<{ adapter: string; result: ToolCall }> };
};
type StepWithTools = { id: string; title: string; agentRole?: string; status: string; output?: string; completedAt?: string; toolCalls?: ToolCall[] };

const CHILD_OUTPUT = "Delegated support note: customers ask about the rate limit first.";
const reply = (output: unknown) => ({ output, model: "scripted-seat", tokens: 10, costCents: 0, fallback: false });
const done = (summary: string) => reply({ toolCall: null, summary, findings: [], recommendations: [], riskNotes: [], whatIDidNotDo: [], workRequests: [] });

describe("ClassicRepl binds delegate_task to the orchestrator's delegated child step", () => {
  it("the engineer's delegate_task spawns a [delegated] support child whose memory write is blocked, and the parent gets its output", async () => {
    const objective = "integrate the partner API and brief support";
    const seatInputs: SeatInput[] = [];
    const events: OrcEvent[] = [];
    let orchestrator: Orchestrator | undefined;
    let received: OrchestratorDepsWithImprove | undefined;
    const factory: ReplDeps["createOrchestrator"] = (deps = {}) => {
      received = deps;
      orchestrator = createOrchestrator({
        ...deps,
        traceSink: (event) => void events.push(event),
        createCompletion: scriptedPlanner(objective) as unknown as (...args: never[]) => unknown,
        executeSeatModelFn: (async (input: SeatInput) => {
          seatInputs.push(input);
          const turn = input.toolLoopContext?.step ?? 1;
          if (input.subtask.objective.startsWith("[delegated]")) {
            // The support child tries to write shared memory (refused: the app's seat loop ends the
            // step on a blocked call); the analyst child answers.
            if (input.subtask.seat === "support") return reply({ toolCall: { name: "memory", action: 'memory {"target":"memory","action":"add","content":"child note"}' }, summary: null });
            return done(CHILD_OUTPUT);
          }
          if (turn === 1) {
            const tasks = [
              { goal: "Write the support note about the partner API", context: "the client is integrated", agent: "support" },
              { goal: "Summarise what customers ask about the partner API", agent: "analyst" },
            ];
            return reply({ toolCall: { name: "delegation", action: `delegate_task ${JSON.stringify({ tasks })}` }, summary: null });
          }
          const fromChildren = input.toolLoopContext?.toolHistory.find((t) => t.adapter === "delegation")?.result.summary ?? "";
          return done(`Integrated the partner API. Delegated results: ${fromChildren}`);
        }) as unknown as (...args: never[]) => unknown,
      });
      return orchestrator;
    };
    const s = session({ createOrchestrator: factory });
    const started = s.repl.start();
    await until(() => atPrompt(s.out));
    s.stdin.emit("data", `${objective}\r`);
    await until(() => s.out.some((chunk) => chunk.includes("Run complete") || chunk.includes("Run failed")), 120_000);
    s.stdin.emit("end");
    await started;

    const transcript = s.out.join("\n");
    expect(transcript).toContain("Run complete");
    expect((received?.tools ?? []).map((tool) => tool.name)).toEqual(["file_ops", "terminal", "delegation"]);

    const runId = events.find((event) => event.kind === "run_start")?.runId;
    expect(runId).toBeDefined();
    const snapshot = await orchestrator!.snapshot(runId!);
    const steps = (snapshot?.steps ?? []) as unknown as StepWithTools[];
    const children = steps.filter((step) => step.title.startsWith("[delegated]"));
    expect(children.map((step) => step.agentRole).sort(), "two [delegated] child steps exist in the run").toEqual(["analyst", "support"]);
    const support = children.find((step) => step.agentRole === "support");
    const childWrite = support?.toolCalls?.find((call) => call.adapter === "memory");
    expect(childWrite?.status).toBe("blocked");
    const analyst = children.find((step) => step.agentRole === "analyst");
    expect(analyst?.status).toBe("completed");
    expect(analyst?.output).toContain(CHILD_OUTPUT);

    const childInput = seatInputs.find((input) => input.subtask.objective.startsWith("[delegated]"));
    expect(childInput?.dynamicPrompt).toContain("## Company memory");

    const parent = steps.find((step) => step.id === "s1");
    expect(parent?.status).toBe("completed");
    expect(parent?.output).toContain(CHILD_OUTPUT);
    const parentCall = parent?.toolCalls?.find((call) => call.adapter === "delegation");
    // The child completed; its blocked memory write is surfaced to the parent unchanged.
    expect(parentCall?.status).toBe("completed");
    expect(parentCall?.summary).toMatch(/memory blocked/);
    expect(parentCall?.summary).toContain(CHILD_OUTPUT);
    expect(parentCall?.summary).toMatch(/read-only memory/);
    // The children ran inside the parent's tool call: both finished before the parent did.
    for (const child of children) expect(child.completedAt! <= parent!.completedAt!).toBe(true);
  }, 180_000);
});
