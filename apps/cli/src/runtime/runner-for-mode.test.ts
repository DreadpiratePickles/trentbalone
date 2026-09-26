/**
 * [S2] `createRunnerForMode`: the runner port by agent mode, as the headless runtime exposes it.
 *
 * Fleet is today's orchestrator stream; solo is one agent's tool loop built from the SAME graph
 * (the tools, the fleet-memory tier builders with `solo.md` kept out of the brain block, the spend
 * meter over the one ledger, the checkpoint ledger), with every frame on the runtime's bus hooks
 * and trace sink. The precedence is a launch override (`--solo`, `trent solo`), then `agent.mode`,
 * then `fleet`. The orchestrator and the model are fakes: nothing here reaches a provider.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ConfigManager } from "@trent/core";
import type { OrcEvent, Orchestrator } from "@trent/core/orchestrator/index.js";
import { scriptedGateway, type ScriptedGateway } from "@trent/core/solo/fakes.test-helpers.js";
import type { SoloAuditRow } from "@trent/core/solo/audit.js";
import { soloPersonaPath } from "@trent/core/solo/prompt.js";
import type { TrentToolAdapter } from "@trent/core/tools/index.js";
import { runCli } from "../commands/index.js";
import { MemoryStore } from "../repl/__tests__/harness.js";
import type { ReplStore } from "../repl/types.js";
import type { EgressHandle } from "../repl/tools.js";
import { createHeadlessRuntime, type HeadlessRuntime, type HeadlessRuntimeDeps } from "./headless.js";
import { savedSoloParks } from "@trent/core/solo/session-store.js";
import { SessionManager } from "@trent/core";
import { modeOverride, resolveAgentMode, soloWindowTokens } from "./runner-for-mode.js";

const REPO_ROOT = path.resolve(__dirname, "../../../..");
let home = "";
const savedHome = process.env.TRENT_HOME;
let n = 0;

beforeAll(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "trent-runner-mode-"));
  process.env.TRENT_HOME = home;
});
afterAll(() => {
  if (savedHome === undefined) delete process.env.TRENT_HOME;
  else process.env.TRENT_HOME = savedHome;
  fs.rmSync(home, { recursive: true, force: true });
});
const runtimes: HeadlessRuntime[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.cleanup();
});

const FLEET_EVENTS: OrcEvent[] = [
  { kind: "run_start", runId: "run_fleet", at: "2026-09-26T09:00:00.000Z", run: { objective: "hello" } } as OrcEvent,
  { kind: "run_done", runId: "run_fleet", at: "2026-09-26T09:00:01.000Z", run: { status: "completed", summary: "fleet answer" } } as OrcEvent,
];

interface Built {
  runtime: HeadlessRuntime;
  profile: string;
  gateway: ScriptedGateway;
  orchestratorRuns: string[];
  approvals: Array<[string, string]>;
  bus: OrcEvent[];
  traced: OrcEvent[];
  audit: SoloAuditRow[];
}

async function build(options: { mode?: "fleet" | "solo"; override?: "fleet" | "solo"; script?: string[]; persona?: string; agent?: Record<string, unknown>; adapters?: TrentToolAdapter[]; windowTokens?: number; holds?: "park" | "deny"; buildTools?: HeadlessRuntimeDeps["buildTools"] } = {}): Promise<Built> {
  n += 1;
  const profile = `mode-${n}`;
  const configManager = new ConfigManager({ profile });
  const config = configManager.loadConfig();
  config.terminal.backend = "local";
  config.provider = "google";
  config.model = "gemini-test";
  if (options.mode !== undefined || options.agent !== undefined) (config as unknown as { agent: Record<string, unknown> }).agent = { ...(config as unknown as { agent?: Record<string, unknown> }).agent, ...options.agent, ...(options.mode === undefined ? {} : { mode: options.mode }) };
  configManager.saveConfig(config);
  if (options.persona !== undefined) {
    fs.mkdirSync(path.dirname(soloPersonaPath(configManager.getProfileDir())), { recursive: true });
    fs.writeFileSync(soloPersonaPath(configManager.getProfileDir()), options.persona, "utf8");
  }
  const orchestratorRuns: string[] = [];
  const approvals: Array<[string, string]> = [];
  const createOrchestrator = (): Orchestrator => ({
    run: (runOptions) => {
      orchestratorRuns.push(runOptions.objective);
      return Object.assign((async function* () { for (const event of FLEET_EVENTS) yield event; })(), {
        runId: "run_fleet", started: Promise.resolve("run_fleet"), result: async () => { throw new Error("iterate instead"); }, cancel: async () => false,
      });
    },
    ensureCompany: async () => "cmp_mode",
    snapshot: async () => undefined,
    approve: async (runId, stepId) => { approvals.push([runId, stepId]); return true; },
    reject: async () => true,
  });
  const adapter = { name: "fake_tool", scopes: ["read"], instructions: "fake_tool: reads nothing.", routingText: "", requiresApproval: () => false, execute: async () => ({ adapter: "fake_tool", action: "x", status: "completed", summary: "" }), cleanup: vi.fn(async () => undefined) } as unknown as TrentToolAdapter;
  const egress: EgressHandle = { port: 1, url: "http://127.0.0.1:1", token: "t", caCertPath: "/dev/null", isListening: () => true, stop: async () => undefined };
  const gateway = scriptedGateway(options.script ?? ["solo answer"]);
  const bus: OrcEvent[] = [];
  const traced: OrcEvent[] = [];
  const audit: SoloAuditRow[] = [];
  const deps: HeadlessRuntimeDeps = {
    configManager,
    workspace: REPO_ROOT,
    surface: "repl",
    createOrchestrator,
    buildAdapters: () => options.adapters ?? [adapter],
    startEgress: async () => egress,
    probeDocker: async () => ({ daemon: false, imagePresent: false }),
    openStore: async () => ({ store: new MemoryStore() as unknown as ReplStore, durable: true }),
    busHooks: [{ sink: (event) => void bus.push(event), flush: async () => undefined }],
    traceSink: (event) => void traced.push(event),
    solo: { gateway, audit: async (row) => void audit.push(row), ...(options.windowTokens === undefined ? {} : { windowTokens: options.windowTokens }) },
    ...(options.holds === undefined ? {} : { holds: options.holds }),
    ...(options.buildTools === undefined ? {} : { buildTools: options.buildTools }),
    ...(options.override === undefined ? {} : { mode: options.override }),
  };
  const runtime = await createHeadlessRuntime(deps);
  runtimes.push(runtime);
  return { runtime, profile, gateway, orchestratorRuns, approvals, bus, traced, audit };
}

async function drain(stream: AsyncIterable<OrcEvent>): Promise<OrcEvent[]> {
  const out: OrcEvent[] = [];
  for await (const event of stream) out.push(event);
  return out;
}

describe("[S2] the mode precedence: launch override, then agent.mode, then fleet", () => {
  it("resolves absent to fleet, config to itself, and a launch override over either", () => {
    expect(resolveAgentMode({})).toBe("fleet");
    expect(resolveAgentMode({ agent: { mode: "solo" } })).toBe("solo");
    expect(resolveAgentMode({ agent: { mode: "fleet" } }, "solo")).toBe("solo");
    expect(resolveAgentMode({ agent: { mode: "solo" } }, "fleet")).toBe("fleet");
    expect(resolveAgentMode({ agent: { mode: "solo" } }, undefined)).toBe("solo");
  });

  it("reads the override off a command's merged options: --solo, or nothing", () => {
    expect(modeOverride({ solo: true })).toBe("solo");
    expect(modeOverride({ solo: false })).toBeUndefined();
    expect(modeOverride({})).toBeUndefined();
  });
});

describe("[S2] createRunnerForMode through the headless runtime", () => {
  it("fleet (the default): the orchestrator's stream, the orchestrator as the approval target, nine seats named", async () => {
    const b = await build();
    expect(b.runtime.mode).toBe("fleet");
    expect(b.runtime.runner.label).toBe("fleet · 9 seats");
    expect((await drain(b.runtime.run("hello"))).map((e) => e.kind)).toEqual(["run_start", "run_done"]);
    expect(b.orchestratorRuns).toEqual(["hello"]);
    expect(await b.runtime.runner.approve("run_fleet", "s1")).toBe(true);
    expect(b.approvals).toEqual([["run_fleet", "s1"]]);
    expect(b.runtime.runner.resume).toBeUndefined();
    expect(b.gateway.requests).toEqual([]);
  });

  it("agent.mode solo: one agent answers through the solo gateway; the orchestrator never runs", async () => {
    const b = await build({ mode: "solo" });
    expect(b.runtime.mode).toBe("solo");
    expect(b.runtime.runner.label).toBe("solo · gemini-test");
    const events = await drain(b.runtime.run("hello"));
    expect(events.map((e) => e.kind)).toEqual(["run_start", "step_start", "step_output", "step_end", "run_done"]);
    expect(events.at(-1)?.run?.summary).toBe("solo answer");
    expect(events[1]?.step?.agentRole).toBe("trent");
    expect(b.orchestratorRuns).toEqual([]);
    expect(b.gateway.requests).toHaveLength(1);
    // Unpinned: the gateway's own executor route, never a model the runner invented.
    expect(b.gateway.requests[0]?.model).toBeUndefined();
  });

  it("a launch override beats the config, both ways", async () => {
    expect((await build({ mode: "fleet", override: "solo" })).runtime.mode).toBe("solo");
    expect((await build({ mode: "solo", override: "fleet" })).runtime.mode).toBe("fleet");
  });

  it("keeps solo.md out of the brain block: the persona is in the system prompt exactly once", async () => {
    const b = await build({ mode: "solo", persona: "You are Trent for Ada. PERSONA-MARKER-S2." });
    await drain(b.runtime.run("plan the week"));
    const system = b.gateway.requests[0]?.messages.find((m) => m.role === "system")?.content ?? "";
    expect(system.split("PERSONA-MARKER-S2").length - 1).toBe(1);
    expect(system).toContain("## Brain");
  });

  it("every solo frame reaches the bus hooks and the trace sink, and the audit rows are the fleet's", async () => {
    const b = await build({ mode: "solo" });
    const events = await drain(b.runtime.run("hello"));
    expect(b.bus).toEqual(events);
    expect(b.traced).toEqual(events);
    expect(b.audit.map((row) => row.action)).toEqual(["orchestration.run_start", "orchestration.step_start", "orchestration.run_done"]);
    expect(b.audit.every((row) => row.companyId === "cmp_mode" && row.objectId === events[0]?.runId)).toBe(true);
  });

  it("the ledger row is seat trent, so `trent usage --by seat` shows it", async () => {
    const b = await build({ mode: "solo" });
    await drain(b.runtime.run("hello"));
    const usage = await runCli(["--profile", b.profile, "usage", "--by", "seat", "--json"]);
    expect(usage.exitCode).toBe(0);
    const report = JSON.parse(usage.stdout) as { today: { groups: Array<{ key: string; cents: number; rows: number }> } };
    expect(report.today.groups).toEqual([expect.objectContaining({ key: "trent", cents: 1, rows: 1 })]);
  });
});

describe("[S2] S1.1's runner settings and state, as the runtime maps them", () => {
  const READ = 'read_file {"path": "big.txt"}';
  const reader = (summary: string) => ({ name: "file_ops", scopes: ["file_ops", "read_file"], instructions: "read_file: reads a file.", routingText: "read_file", requiresApproval: () => false, execute: async (action: string) => ({ adapter: "file_ops", action, status: "completed", summary }), cleanup: async () => undefined }) as unknown as TrentToolAdapter;

  it("agent.solo.max_tool_result_chars caps what the model is shown of a tool result", async () => {
    const b = await build({ mode: "solo", agent: { solo: { max_tool_result_chars: 40 } }, adapters: [reader("x".repeat(500))], script: [`<tool_call>\n${READ}\n</tool_call>`, "It is long."] });
    await drain(b.runtime.run("read big.txt"));
    const told = (b.gateway.requests[1]?.messages ?? []).map((m) => m.content).join("\n");
    expect(told).toContain("[truncated: this result is 500 characters; the first 40 are shown (agent.solo.max_tool_result_chars)]");
  });

  it("the model's window bounds the request: over it, nothing is sent and the run fails naming the window", async () => {
    const b = await build({ mode: "solo", windowTokens: 50 });
    const events = await drain(b.runtime.run("hello"));
    expect(b.gateway.requests).toEqual([]);
    expect(events.at(-1)?.kind).toBe("run_failed");
    expect(events.at(-1)?.detail).toContain("window is 50 tokens");
  });

  it("the window comes from the local runtime on a local provider, and is absent on a hosted one", async () => {
    const refused = async (): Promise<Response> => { throw new Error("no server in this test"); };
    expect(await soloWindowTokens("gemini-test", {})).toBeUndefined();
    expect(await soloWindowTokens("qwen3.5:9b", { TRENT_MODEL_ALIAS: "ollama", TRENT_LOCAL_CONTEXT_TOKENS: "16384" }, refused)).toBe(16384);
  });

  it("a profile session keeps the runner's state beside its transcript, so a restart can find the park", async () => {
    const social = { name: "social", scopes: ["social", "social_post"], instructions: "social_post: posts.", routingText: "social_post", requiresApproval: () => true, dryRun: async (action: string) => ({ adapter: "social", action, status: "needs_approval", summary: "held as appr_s2" }), execute: async (action: string) => ({ adapter: "social", action, status: "completed", summary: "posted" }), cleanup: async () => undefined } as unknown as TrentToolAdapter;
    const b = await build({ mode: "solo", holds: "park", adapters: [social], script: ['<tool_call>\nsocial_post {"text": "hi"}\n</tool_call>'] });
    const sessions = new SessionManager(new ConfigManager({ profile: b.profile }));
    const id = sessions.startSession("trent", "gemini-test", "google").id;
    const events = await drain(b.runtime.run("post hi", { session: id }));
    expect(events.at(-1)?.kind).toBe("run_awaiting_approval");
    expect(savedSoloParks(sessions.getStore())).toEqual([expect.objectContaining({ sessionId: id, runId: events[0]?.runId })]);
    expect(b.runtime.runner.parked?.()).toEqual([expect.objectContaining({ runId: events[0]?.runId, adapter: "social" })]);
  });
});

describe("[S2] the two seams the webhook routes need (H3)", () => {
  const SEND = '<tool_call>\nsocial_post {"text": "deploy finished"}\n</tool_call>';
  /** A post adapter wrapped by the runtime's OWN policy dispatcher, as `buildTrentTools` wraps the real ones. */
  function withPolicy(social: TrentToolAdapter) {
    return (_config: unknown, deps: { policy?: { wrap(adapters: readonly TrentToolAdapter[]): TrentToolAdapter[] } }) => ({ adapters: deps.policy === undefined ? [social] : deps.policy.wrap([social]), skipped: [], hookNotices: [] });
  }
  const poster = () => {
    const calls: string[] = [];
    const adapter = { name: "social", scopes: ["social", "social_post"], instructions: "social_post: posts.", routingText: "social_post", requiresApproval: () => false, dryRun: async (action: string) => ({ adapter: "social", action, status: "needs_approval", summary: "held" }), execute: async (action: string) => (calls.push(action), { adapter: "social", action, status: "completed", summary: "posted" }), cleanup: async () => undefined } as unknown as TrentToolAdapter;
    return { adapter, calls };
  };

  it("runnerFor(mode) hands out the fleet or the solo runner whatever the launch's mode", async () => {
    const fleet = await build();
    expect(fleet.runtime.runnerFor("fleet")).toBe(fleet.runtime.runner);
    expect(fleet.runtime.runnerFor("solo").mode).toBe("solo");
    expect(fleet.runtime.runnerFor("solo")).toBe(fleet.runtime.runnerFor("solo"));
    const events = await drain(fleet.runtime.runnerFor("solo").run({ objective: "hello", surface: "webhook" }));
    expect(events.at(-1)).toMatchObject({ kind: "run_done", run: { summary: "solo answer" } });
    const solo = await build({ mode: "solo" });
    expect(solo.runtime.runnerFor("fleet").mode).toBe("fleet");
  });

  it("seedInbound puts an inbound read in the run's ring, so the run's first send trips send-after-untrusted", async () => {
    for (const seeded of [true, false]) {
      const { adapter, calls } = poster();
      const b = await build({ mode: "solo", script: [SEND, "done"], buildTools: withPolicy(adapter) } as never);
      const seen: OrcEvent[] = [];
      for await (const event of b.runtime.runnerFor("solo").run({ objective: "a webhook said: deploy finished", surface: "webhook", holds: "park" })) {
        seen.push(event);
        if (seeded && event.kind === "run_start") await b.runtime.seedInbound(event.runId, "webhook:deploy");
      }
      if (seeded) {
        expect(seen.at(-1)?.kind).toBe("run_awaiting_approval");
        expect(seen.at(-1)?.detail).toContain("Policy rule send-after-untrusted");
        expect(calls).toEqual([]);
      } else {
        expect(seen.at(-1)?.kind).toBe("run_done");
        expect(calls).toHaveLength(1);
      }
    }
  });
});
