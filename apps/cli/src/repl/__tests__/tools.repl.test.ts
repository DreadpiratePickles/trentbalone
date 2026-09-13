/**
 * The shipped REPL (`ClassicRepl`) with its toolsets and egress proxy wired in.
 *
 *   - `createOrchestrator` receives the adapters for `config.toolsets` (a recording factory);
 *   - with egress enabled the proxy is listening before the first turn and NOT after exit —
 *     via stdin end, via a thrown start error, and via Ctrl+C (exit 130);
 *   - one end-to-end offline run: "print the name field of package.json" through the real
 *     orchestrator with scripted planner/seat ports renders a `file_ops` activity line and the
 *     real package name.
 */

import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ConfigManager } from "@trent/core";
import { createTheme } from "../../ui/index.js";
import { createOrchestrator, type Orchestrator, type OrchestratorDepsWithImprove } from "@trent/core/orchestrator/index.js";
import { PROMPT } from "../engine.js";
import { ClassicRepl, type ReplDeps } from "../index.js";
import type { EgressHandle } from "../tools.js";

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
  home = mkdtempSync(path.join(os.tmpdir(), "trent-tools-repl-"));
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

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
});

async function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

/** The prompt line itself, not the banner's `●` glyphs: `writeLine(theme.accent(PROMPT) + draft)`. */
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
  exit: ReturnType<typeof vi.fn>;
  profile: string;
  configManager: ConfigManager;
}

function session(configure: (manager: ConfigManager) => void, deps: ReplDeps): Session {
  profileN += 1;
  const profile = `tools-${profileN}`;
  const configManager = new ConfigManager({ profile });
  const config = configManager.loadConfig();
  config.terminal.backend = "local";
  configManager.saveConfig(config);
  configure(configManager);
  const stdin = new ScriptedStdin();
  const out: string[] = [];
  const exit = vi.fn();
  const repl = new ClassicRepl({
    profile,
    io: { write: (text) => void out.push(text), isTTY: false, stdin: stdin as never, exit: (code) => void exit(code), theme: createTheme("none"), width: 80 },
    deps: { workspace: REPO_ROOT, ...deps },
  });
  return { repl, stdin, out, exit, profile, configManager };
}

/** A recording `createOrchestrator` that never touches the model: every run is a no-op stream. */
function recordingFactory(): { factory: ReplDeps["createOrchestrator"]; received: OrchestratorDepsWithImprove[]; throwOnCreate?: Error } {
  const received: OrchestratorDepsWithImprove[] = [];
  const state: { throwOnCreate?: Error } = {};
  const factory: ReplDeps["createOrchestrator"] = (deps = {}) => {
    received.push(deps);
    if (state.throwOnCreate) throw state.throwOnCreate;
    const real = createOrchestrator(deps);
    return real;
  };
  return { factory, received, get throwOnCreate() { return state.throwOnCreate; }, set throwOnCreate(e) { state.throwOnCreate = e; } };
}

/** The real proxy, but observed: the test can ask which port it took and whether it still listens. */
function observedEgress(): { startEgress: ReplDeps["startEgress"]; handles: EgressHandle[] } {
  const handles: EgressHandle[] = [];
  const startEgress: ReplDeps["startEgress"] = async (input) => {
    const { startEgressProxy } = await import("../tools.js");
    const handle = await startEgressProxy(input);
    handles.push(handle);
    return handle;
  };
  return { startEgress, handles };
}

describe("ClassicRepl wires the toolsets into the orchestrator", () => {
  it("createOrchestrator receives the file_ops and terminal adapters", async () => {
    const recorder = recordingFactory();
    const s = session(() => undefined, { createOrchestrator: recorder.factory, startEgress: async () => { throw new Error("egress not under test"); } });
    const started = s.repl.start();
    await until(() => atPrompt(s.out));
    s.stdin.emit("end");
    await started;

    expect(recorder.received).toHaveLength(1);
    expect((recorder.received[0]?.tools ?? []).map((tool) => tool.name)).toEqual(["file_ops", "terminal"]);
    const everything = s.out.join("");
    expect(everything).toContain("file_ops");
    expect(everything).toContain("terminal");
  }, 30_000);
});

describe("ClassicRepl and the egress proxy lifecycle", () => {
  it("is listening before the first turn and not after stdin ends", async () => {
    const recorder = recordingFactory();
    const egress = observedEgress();
    const s = session(() => undefined, { createOrchestrator: recorder.factory, startEgress: egress.startEgress });
    const started = s.repl.start();
    await until(() => atPrompt(s.out));

    expect(egress.handles).toHaveLength(1);
    const port = egress.handles[0]!.port;
    expect(await portOpen(port)).toBe(true);
    const handed = recorder.received[0]?.tools?.length ?? 0;
    expect(handed).toBe(2);

    s.stdin.emit("end");
    await started;
    expect(await portOpen(port)).toBe(false);
  }, 30_000);

  it("is stopped when start() throws", async () => {
    const recorder = recordingFactory();
    recorder.throwOnCreate = new Error("boom: orchestrator refused to build");
    const egress = observedEgress();
    const s = session(() => undefined, { createOrchestrator: recorder.factory, startEgress: egress.startEgress });
    await expect(s.repl.start()).rejects.toThrow("boom");

    expect(egress.handles).toHaveLength(1);
    expect(await portOpen(egress.handles[0]!.port)).toBe(false);
  }, 30_000);

  it("is stopped on Ctrl+C, which exits 130", async () => {
    const recorder = recordingFactory();
    const egress = observedEgress();
    const s = session(() => undefined, { createOrchestrator: recorder.factory, startEgress: egress.startEgress });
    const started = s.repl.start();
    cleanups.push(async () => {
      s.stdin.emit("end");
      await started;
    });
    await until(() => atPrompt(s.out));
    const port = egress.handles[0]!.port;
    expect(await portOpen(port)).toBe(true);

    s.stdin.emit("data", "\x03");
    await until(() => s.exit.mock.calls.length > 0);
    expect(s.exit).toHaveBeenCalledWith(130);
    expect(await portOpen(port)).toBe(false);
  }, 30_000);

  it("with egress disabled no proxy starts", async () => {
    const recorder = recordingFactory();
    const startEgress = vi.fn();
    const s = session((manager) => {
      const config = manager.loadConfig();
      config.egress.enabled = false;
      manager.saveConfig(config);
    }, { createOrchestrator: recorder.factory, startEgress });
    const started = s.repl.start();
    await until(() => atPrompt(s.out));
    s.stdin.emit("end");
    await started;
    expect(startEgress).not.toHaveBeenCalled();
    expect(s.out.join("")).toMatch(/egress off/i);
  }, 30_000);
});

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
          reasoning: "scripted plan: one engineer step that must read the file",
          steps: [{ id: "s1", title: "Read package.json and print its name field", rationale: "the objective", agentRole: "engineer",
            dependsOn: [], expectedOutput: "The name value from package.json", riskLevel: "low", needsApproval: false }],
          successCriteria: ["name reported"],
          blockers: [],
        }),
        totalTokens: 12,
      };
    }
    return { content: JSON.stringify({ summary: "scripted consolidation", findings: [], recommendations: [], workRequests: [] }), totalTokens: 4 };
  };
}

type SeatInput = {
  toolLoopContext?: { step: number; toolHistory: Array<{ adapter: string; result: { summary: string } }> };
};

describe("end to end, offline: the REPL reads package.json through file_ops", () => {
  it("renders a file_ops activity line and the real package name", async () => {
    const objective = "print the name field of package.json";
    const expectedName = (JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as { name: string }).name;
    let orchestrator: Orchestrator | undefined;
    const factory: ReplDeps["createOrchestrator"] = (deps = {}) => {
      orchestrator = createOrchestrator({
        ...deps,
        createCompletion: scriptedPlanner(objective) as unknown as (...args: never[]) => unknown,
        executeSeatModelFn: (async (input: SeatInput) => {
          const loop = input.toolLoopContext;
          const reply = (output: unknown) => ({ output, model: "scripted-seat", tokens: 10, costCents: 0, fallback: false });
          if ((loop?.step ?? 1) === 1) return reply({ toolCall: { name: "file_ops", action: 'read_file {"path":"package.json"}' }, summary: null });
          const fromTool = loop?.toolHistory.find((t) => t.adapter === "file_ops")?.result.summary ?? "";
          const name = /"name":\s*"([^"]+)"/.exec(fromTool)?.[1] ?? "(not found in tool result)";
          return reply({ toolCall: null, summary: `The name field of package.json is ${name}.`, findings: [], recommendations: [], riskNotes: [], whatIDidNotDo: [], workRequests: [] });
        }) as unknown as (...args: never[]) => unknown,
      });
      return orchestrator;
    };
    const s = session(() => undefined, { createOrchestrator: factory, startEgress: async () => { throw new Error("egress not under test"); } });
    const started = s.repl.start();
    await until(() => atPrompt(s.out));

    s.stdin.emit("data", `${objective}\r`);
    await until(() => s.out.some((chunk) => chunk.includes("Run complete") || chunk.includes("Run failed")), 120_000);
    s.stdin.emit("end");
    await started;

    const transcript = s.out.join("\n");
    expect(transcript).not.toContain("Run failed");
    expect(transcript).toContain("Run complete");
    expect(transcript).toMatch(/file_ops[^\n]*read_file/);
    expect(transcript).toContain(expectedName);
    expect(transcript).not.toMatch(/not allowed for this seat/);
  }, 180_000);
});
