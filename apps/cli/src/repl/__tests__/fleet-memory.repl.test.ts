/**
 * The shipped REPL (`ClassicRepl`) hands the orchestrator a live fleet memory: the `memory` and
 * `fleet_search` adapters are registered next to the toolsets, `/tools` lists them, and a seat's
 * prompt on the very first turn carries the shared "Company memory" prelude. Offline: a recording
 * `createOrchestrator`, a scripted planner and a scripted seat; no Docker, no proxy, no provider.
 */

import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ConfigManager } from "@trent/core";
import { createTheme } from "../../ui/index.js";
import { createOrchestrator, type OrchestratorDepsWithImprove } from "@trent/core/orchestrator/index.js";
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
  home = mkdtempSync(path.join(os.tmpdir(), "trent-fleet-repl-"));
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

interface Session {
  repl: ClassicRepl;
  stdin: ScriptedStdin;
  out: string[];
}

function session(deps: ReplDeps): Session {
  profileN += 1;
  const profile = `fleet-${profileN}`;
  const configManager = new ConfigManager({ profile });
  const config = configManager.loadConfig();
  config.terminal.backend = "local";
  config.egress.enabled = false;
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
          reasoning: "scripted plan: one engineer step",
          steps: [{ id: "s1", title: "Answer the question", rationale: "the objective", agentRole: "engineer",
            dependsOn: [], expectedOutput: "an answer", riskLevel: "low", needsApproval: false }],
          successCriteria: ["answered"],
          blockers: [],
        }),
        totalTokens: 12,
      };
    }
    return { content: JSON.stringify({ summary: "scripted consolidation", findings: [], recommendations: [], workRequests: [] }), totalTokens: 4 };
  };
}

type SeatInput = { subtask: { seat: string }; dynamicPrompt?: string };

describe("ClassicRepl wires fleet memory into the orchestrator", () => {
  it("registers fleet_search and memory next to the toolsets, and /tools lists them", async () => {
    const received: OrchestratorDepsWithImprove[] = [];
    const factory: ReplDeps["createOrchestrator"] = (deps = {}) => {
      received.push(deps);
      return createOrchestrator(deps);
    };
    const s = session({ createOrchestrator: factory });
    const started = s.repl.start();
    await until(() => atPrompt(s.out));
    s.stdin.emit("data", "/tools\r");
    await until(() => s.out.filter((chunk) => chunk === `${PROMPT}\n`).length >= 2);
    s.stdin.emit("end");
    await started;

    expect(received).toHaveLength(1);
    const fleetMemory = received[0]?.fleetMemory;
    expect(fleetMemory).toBeDefined();
    const names = (fleetMemory?.adapters ?? []).map((adapter) => adapter.name);
    expect(names).toContain("fleet_search");
    expect(names).toContain("memory");
    // The toolsets themselves are untouched: fleet memory rides in its own dependency.
    expect((received[0]?.tools ?? []).map((tool) => tool.name)).toEqual(expect.arrayContaining(["file_ops", "terminal"]));
    expect(s.out.join("")).toContain("fleet_search");
  }, 30_000);

  it("the first turn's seat prompt carries the shared Company memory prelude", async () => {
    const objective = "what is the rate limit of the partner API";
    const seatInputs: SeatInput[] = [];
    const factory: ReplDeps["createOrchestrator"] = (deps = {}) =>
      createOrchestrator({
        ...deps,
        createCompletion: scriptedPlanner(objective) as unknown as (...args: never[]) => unknown,
        executeSeatModelFn: (async (input: SeatInput) => {
          seatInputs.push(input);
          return {
            output: { toolCall: null, summary: "scripted answer", findings: [], recommendations: [], riskNotes: [], whatIDidNotDo: [], workRequests: [] },
            model: "scripted-seat",
            tokens: 10,
            costCents: 0,
            fallback: false,
          };
        }) as unknown as (...args: never[]) => unknown,
      });
    const s = session({ createOrchestrator: factory });
    const started = s.repl.start();
    await until(() => atPrompt(s.out));
    s.stdin.emit("data", `${objective}\r`);
    await until(() => s.out.some((chunk) => chunk.includes("Run complete") || chunk.includes("Run failed")), 120_000);
    s.stdin.emit("end");
    await started;

    expect(s.out.join("\n")).toContain("Run complete");
    expect(seatInputs.length).toBeGreaterThan(0);
    const prelude = seatInputs[0]?.dynamicPrompt ?? "";
    expect(prelude).toContain("## Company memory");
    expect(seatInputs[0]?.subtask.seat).toBe("engineer");
  }, 180_000);
});
