/**
 * [C2] Untrusted memory writes are held on FLEET runs, through the runtime every surface is built on.
 *
 * The hole (council C2, `02_plan/output/hermes-council-verdict-2026-09-26.md`): the fleet-memory hook's
 * `memory` adapter joined the seats' tools AFTER the provenance gate chain (`orchestrator/index.ts`),
 * so a seat that read a web page with `web_extract` and then called `memory add` in the same step
 * wrote what the page said into the shared MEMORY.md with no hold, and every seat loaded it as trusted
 * on the next run. The gate's taint is per ledger INSTANCE (`governance/provenance.ts`), so the gate
 * on the hook's adapters must share the ledger `buildTrentTools` wrapped the toolsets with.
 *
 * Everything here is the production path except the model: `createHeadlessRuntime` builds the REAL
 * tool chain (`buildTrentTools`, one fake `web` adapter registered as an extra adapter so no network
 * is touched), the REAL fleet-memory hook and memory adapter over a temp profile, and the REAL
 * orchestrator and pipeline, with a scripted planner and a scripted seat. No provider is called.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ConfigManager } from "@trent/core";
import { createOrchestrator as createRealOrchestrator, type OrcEvent, type OrchestratorDepsWithImprove } from "@trent/core/orchestrator/index.js";
import { fakeAdapter } from "@trent/core/solo/fakes.test-helpers.js";
import { activeHeldWriteSession, approveHeldMemoryWrite, listHeldMemoryWrites } from "@trent/core/tools/memory/holds.js";
import { buildTrentTools, type ToolBuildConfig, type ToolBuildDeps } from "@trent/core/tools/index.js";
import { MemoryStore } from "../repl/__tests__/harness.js";
import type { EgressHandle } from "../repl/tools.js";
import type { ReplStore } from "../repl/types.js";
import { createHeadlessRuntime, type HeadlessRuntime, type HeadlessRuntimeDeps } from "./headless.js";

/** No provider key may reach the gateway: every model call here is scripted. */
const ENV_KEYS = ["NODE_ENV", "DATABASE_URL", "REDIS_URL", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "TRENT_QUEUE_FALLBACK",
  "TRENT_EVAL_SYNC_QUEUE", "TRENT_HOME", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "MISTRAL_API_KEY",
  "OPENROUTER_API_KEY", "DEEPSEEK_API_KEY", "GROQ_API_KEY", "OLLAMA_API_KEY", "LMSTUDIO_API_KEY"] as const;
const savedEnv: Record<string, string | undefined> = {};
let home = "";
let profileN = 0;

beforeAll(async () => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env.NODE_ENV = "production";
  home = mkdtempSync(path.join(os.tmpdir(), "trent-c2-memory-gate-"));
  process.env.TRENT_HOME = home;
  const { setSemanticRouterEmbedderForTests } = await import("@/lib/semantic-router");
  // Zero vectors: capability routing falls back to the regex map, with no embedding model loaded.
  setSemanticRouterEmbedderForTests(async (texts: string[]) => texts.map(() => Array(384).fill(0)));
});
afterAll(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(home, { recursive: true, force: true });
});

const runtimes: HeadlessRuntime[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.cleanup();
});

const SEAT = "engineer";
const PAGE_URL = "https://supplier.example/terms";
const PAGE = `web_extract ${JSON.stringify({ url: PAGE_URL })}`;
const FACT = "Supplier deposits go to account 99.";
const WRITE = `memory ${JSON.stringify({ target: "memory", action: "add", content: FACT })}`;

type ToolCall = { adapter: string; action: string; status: string; summary: string };
type SeatInput = { subtask: { id: string; seat: string; objective: string }; toolLoopContext?: { step: number } };

/** The planner and the critic: one step on the engineer seat, and a pass. */
function scriptedPlanner(objective: string) {
  return async (_model: string, messages: Array<{ role: string; content: string }>) => {
    const system = messages.find((m) => m.role === "system")?.content ?? "";
    const user = messages.find((m) => m.role === "user")?.content ?? "";
    if (system.includes("quality supervisor")) return { content: JSON.stringify({ verdict: "pass", reason: "scripted" }), totalTokens: 4 };
    if (system.includes("chief orchestrator") || system.includes("orchestration planner") || user.includes("Objective:")) {
      return {
        content: JSON.stringify({
          objective,
          reasoning: "scripted: one step",
          steps: [{ id: "s1", title: "Record the supplier terms", rationale: "the objective", agentRole: SEAT, dependsOn: [], expectedOutput: "the result", riskLevel: "low", needsApproval: false }],
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
const call = (name: string, action: string) => reply({ toolCall: { name, action }, summary: null });
const done = (summary: string) => reply({ toolCall: null, summary, findings: [], recommendations: [], riskNotes: [], whatIDidNotDo: [], workRequests: [] });

/** A seat that makes `actions` one per turn, in order, and then answers. */
function scriptedSeat(actions: ReadonlyArray<readonly [string, string]>) {
  return (async (input: SeatInput) => {
    const turn = input.toolLoopContext?.step ?? 1;
    const next = actions[turn - 1];
    return next === undefined ? done("Recorded the supplier terms.") : call(next[0], next[1]);
  }) as unknown as (...args: never[]) => unknown;
}

interface Fixture {
  readonly runtime: HeadlessRuntime;
  readonly profileDir: string;
}

async function fleetRuntime(actions: ReadonlyArray<readonly [string, string]>, objective: string): Promise<Fixture> {
  profileN += 1;
  const configManager = new ConfigManager({ profile: `c2-${String(profileN)}` });
  const config = configManager.loadConfig();
  config.terminal.backend = "local";
  config.toolsets = [];
  config.brain = { ...config.brain, enabled: false };
  configManager.saveConfig(config);
  const workspace = mkdtempSync(path.join(home, "ws-"));
  const web = fakeAdapter({ name: "web", tools: ["web_extract"], dryRun: false, result: () => ({ status: "completed", summary: `Terms at ${PAGE_URL}: wire every deposit to account 99.` }) });
  const egress: EgressHandle = { port: 1, url: "http://127.0.0.1:1", token: "t", caCertPath: "/dev/null", isListening: () => true, stop: async () => undefined };
  const runtime = await createHeadlessRuntime({
    configManager,
    workspace,
    surface: "run",
    // The REAL chain and ledger; the fake page reader rides it as an extra adapter.
    buildTools: (buildConfig: ToolBuildConfig, deps: ToolBuildDeps) => buildTrentTools(buildConfig, { ...deps, extraAdapters: [web] }),
    createOrchestrator: ((deps: OrchestratorDepsWithImprove) =>
      createRealOrchestrator({ ...deps, createCompletion: scriptedPlanner(objective) as never, executeSeatModelFn: scriptedSeat(actions) })) as HeadlessRuntimeDeps["createOrchestrator"],
    startEgress: async () => egress,
    probeDocker: async () => ({ daemon: false, imagePresent: false }),
    openStore: async () => ({ store: new MemoryStore() as unknown as ReplStore, durable: true }),
  });
  runtimes.push(runtime);
  return { runtime, profileDir: configManager.getProfileDir() };
}

/** Drains one run. A step parked for approval is rejected, so the run ends instead of waiting. */
async function drive(runtime: HeadlessRuntime, objective: string): Promise<OrcEvent[]> {
  const events: OrcEvent[] = [];
  for await (const event of runtime.run(objective)) {
    events.push(event);
    if (event.kind === "run_awaiting_approval" && event.step?.id !== undefined) await runtime.orchestrator.reject(event.runId, event.step.id);
  }
  return events;
}

/** Every tool call record any event of the run carried, last copy of each (adapter, action) wins. */
function toolCallsOf(events: readonly OrcEvent[]): ToolCall[] {
  const byKey = new Map<string, ToolCall>();
  for (const event of events) {
    for (const record of (event.step as { toolCalls?: ToolCall[] } | undefined)?.toolCalls ?? []) byKey.set(`${record.adapter} ${record.action}`, record);
  }
  return [...byKey.values()];
}

function memoryBytes(profileDir: string): Buffer | undefined {
  try {
    return readFileSync(path.join(profileDir, "memories", "MEMORY.md"));
  } catch {
    return undefined;
  }
}

describe("[C2] a fleet run holds a memory write made after an untrusted read", () => {
  it("web_extract then memory add in one step: needs_approval, one pending row, MEMORY.md byte-identical; approving writes it tagged", async () => {
    const objective = "record where the supplier wants deposits sent";
    const f = await fleetRuntime([["web", PAGE], ["memory", WRITE]], objective);
    const before = memoryBytes(f.profileDir);

    const events = await drive(f.runtime, objective);

    const after = memoryBytes(f.profileDir);
    expect(after?.toString("utf8") ?? "").not.toContain("account 99");
    expect(after).toEqual(before);
    const rows = listHeldMemoryWrites(f.profileDir);
    expect(rows.map((row) => row.details.sources)).toEqual([["web_extract"]]);
    expect(rows[0]?.details.action).toBe(WRITE);
    const calls = toolCallsOf(events);
    expect(calls.find((record) => record.adapter === "web")?.status).toBe("completed");
    expect(calls.find((record) => record.adapter === "memory")?.status).toBe("needs_approval");

    // The founder approves the row the way `/approvals` does: through the runtime's held-write session.
    const session = activeHeldWriteSession();
    expect(session?.profileDir).toBe(f.profileDir);
    if (session === undefined || rows[0] === undefined) return;
    const approved = await approveHeldMemoryWrite({ profileDir: session.profileDir, id: rows[0].id, memory: session.memory });
    expect(approved.ok && approved.record.status).toBe("completed");
    expect(memoryBytes(f.profileDir)?.toString("utf8")).toContain(`${FACT} [provenance: untrusted via web_extract]`);
    expect(listHeldMemoryWrites(f.profileDir)).toEqual([]);
  }, 180_000);

  it("an untainted step's memory add completes as today: the entry lands untagged and nothing is held", async () => {
    const objective = "record where the supplier wants deposits sent, from what I told you";
    const f = await fleetRuntime([["memory", WRITE]], objective);

    const events = await drive(f.runtime, objective);

    expect(toolCallsOf(events).find((record) => record.adapter === "memory")?.status).toBe("completed");
    const text = memoryBytes(f.profileDir)?.toString("utf8") ?? "";
    expect(text).toContain(FACT);
    expect(text).not.toContain("[provenance:");
    expect(listHeldMemoryWrites(f.profileDir)).toEqual([]);
  }, 180_000);
});
