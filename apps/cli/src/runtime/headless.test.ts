/**
 * The headless session runtime: the object graph the REPL builds (store, tools, fleet memory, the
 * improve loop, the orchestrator, the company) with no terminal attached. Every collaborator that
 * would touch a daemon, a proxy or a model is injected here; what is under test is the wiring.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ConfigManager } from "@trent/core";
import type { OrcEvent, Orchestrator, OrchestratorDepsWithImprove } from "@trent/core/orchestrator/index.js";
import type { TrentToolAdapter } from "@trent/core/tools/index.js";
import { hookSpecHash, writeConsent, type HookSpec } from "@trent/core/hooks/index.js";
import { trustWorkspace } from "@trent/core/workspace-context/index.js";
import { CONTEXT_BLOCKS } from "@trent/core/fleet-memory/index.js";
import { MemoryStore } from "../repl/__tests__/harness.js";
import type { ReplStore } from "../repl/types.js";
import type { EgressHandle } from "../repl/tools.js";
import { createHeadlessRuntime, type HeadlessRuntime, type HeadlessRuntimeDeps } from "./headless.js";

const REPO_ROOT = path.resolve(__dirname, "../../../..");
const COMPANY_ID = "cmp_headless";

let home = "";
const savedHome = process.env.TRENT_HOME;
let profileN = 0;

beforeAll(() => {
  home = mkdtempSync(path.join(os.tmpdir(), "trent-headless-"));
  process.env.TRENT_HOME = home;
});
afterAll(() => {
  if (savedHome === undefined) delete process.env.TRENT_HOME;
  else process.env.TRENT_HOME = savedHome;
  rmSync(home, { recursive: true, force: true });
});

const runtimes: HeadlessRuntime[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.cleanup();
});

function ev(kind: OrcEvent["kind"], extra: Partial<OrcEvent> = {}): OrcEvent {
  return { kind, runId: "run_h", at: "2026-09-15T00:00:00.000Z", ...extra } as OrcEvent;
}

const EVENTS: OrcEvent[] = [
  ev("run_start", { run: { objective: "hello" } }),
  ev("run_done", { run: { status: "completed" } }),
];

// [B2.1] model tiers
/** The `models` block on the orchestrator's model dep, which `OrchestratorModelConfig` accepts structurally. */
interface ModelTiers {
  models?: { fast?: string; executor?: string; planner?: string; judge?: string };
}
const GOOGLE_TIER_VARS = ["MODEL_PREFERRED_PROVIDER", "GOOGLE_MODEL_FAST", "GOOGLE_MODEL_DEFAULT", "GOOGLE_MODEL_STRONG"];
const OPENAI_TIER_VARS = ["MODEL_PREFERRED_PROVIDER", "OPENAI_MODEL_FAST", "OPENAI_MODEL_DEFAULT", "OPENAI_MODEL_STRONG", "OPENAI_MODEL_CRITIC"];

/** Runs `fn` with `names` unset, restoring every one of them (including absence) afterwards. */
async function withCleanEnv(names: readonly string[], fn: () => Promise<void>): Promise<void> {
  const saved = names.map((name) => [name, process.env[name]] as const);
  for (const name of names) delete process.env[name];
  try {
    await fn();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

interface Fakes {
  deps: HeadlessRuntimeDeps;
  received: OrchestratorDepsWithImprove[];
  runOptions: Parameters<Orchestrator["run"]>[0][];
  ensureCompany: ReturnType<typeof vi.fn>;
  adapterCleanup: ReturnType<typeof vi.fn>;
  egressStop: ReturnType<typeof vi.fn>;
  store: MemoryStore;
}

function fakes(configure: (manager: ConfigManager) => void = () => undefined): Fakes {
  profileN += 1;
  const configManager = new ConfigManager({ profile: `headless-${profileN}` });
  const config = configManager.loadConfig();
  config.terminal.backend = "local";
  configManager.saveConfig(config);
  configure(configManager);

  const received: OrchestratorDepsWithImprove[] = [];
  const runOptions: Parameters<Orchestrator["run"]>[0][] = [];
  const ensureCompany = vi.fn(async () => COMPANY_ID);
  const adapterCleanup = vi.fn(async () => undefined);
  const egressStop = vi.fn(async () => undefined);
  const store = new MemoryStore();

  const createOrchestrator = (deps: OrchestratorDepsWithImprove = {}): Orchestrator => {
    received.push(deps);
    return {
      run: (options) => {
        runOptions.push(options);
        const iterable = (async function* () {
          for (const event of EVENTS) yield event;
        })();
        return Object.assign(iterable, {
          runId: "run_h",
          started: Promise.resolve("run_h"),
          result: async () => {
            throw new Error("not used by this test");
          },
          cancel: async () => false,
        });
      },
      ensureCompany,
      snapshot: async () => undefined,
      approve: async () => true,
      reject: async () => true,
    };
  };

  const adapter: TrentToolAdapter = {
    name: "fake_tool",
    scopes: ["read"],
    instructions: "",
    routingText: "",
    execute: async () => ({ ok: true, output: "" }),
    cleanup: adapterCleanup,
  } as unknown as TrentToolAdapter;

  const handle: EgressHandle = {
    port: 1,
    url: "http://127.0.0.1:1",
    token: "t",
    caCertPath: "/dev/null",
    isListening: () => true,
    stop: egressStop,
  };

  const deps: HeadlessRuntimeDeps = {
    configManager,
    workspace: REPO_ROOT,
    createOrchestrator,
    buildAdapters: () => [adapter],
    startEgress: async () => handle,
    probeDocker: async () => ({ daemon: false, imagePresent: false }),
    openStore: async () => ({ store: store as unknown as ReplStore, durable: true }),
  };
  return { deps, received, runOptions, ensureCompany, adapterCleanup, egressStop, store };
}

describe("createHeadlessRuntime", () => {
  it("run(objective) yields the orchestrator's events for the ensured company with the given trigger", async () => {
    const f = fakes();
    const runtime = await createHeadlessRuntime(f.deps);
    runtimes.push(runtime);

    expect(f.ensureCompany).toHaveBeenCalledWith({ name: "Trent Local", slug: "trent-local" });
    expect(runtime.companyId).toBe(COMPANY_ID);

    const seen: OrcEvent["kind"][] = [];
    const controller = new AbortController();
    for await (const event of runtime.run("hello", { trigger: "scheduled", signal: controller.signal })) seen.push(event.kind);
    expect(seen).toEqual(["run_start", "run_done"]);
    expect(f.runOptions).toEqual([{ companyId: COMPANY_ID, objective: "hello", trigger: "scheduled", signal: controller.signal }]);
  });

  it("trigger defaults to manual, and the runtime exposes the graph it built", async () => {
    const f = fakes();
    const runtime = await createHeadlessRuntime(f.deps);
    runtimes.push(runtime);

    for await (const _ of runtime.run("hello")) void _;
    expect(f.runOptions[0]?.trigger).toBe("manual");

    expect(runtime.store).toBe(f.store);
    expect(runtime.durable).toBe(true);
    expect(runtime.tools.adapters.map((adapter) => adapter.name)).toEqual(["fake_tool"]);
    expect(runtime.fleetMemory.adapters.length).toBeGreaterThan(0);
    expect(typeof runtime.improve.improve.sink).toBe("function");
    // The orchestrator received the same adapters, memory hook and improve deps the runtime exposes.
    const deps = f.received[0];
    expect(deps?.tools).toBe(runtime.tools.adapters);
    expect(deps?.fleetMemory).toBe(runtime.fleetMemory);
    expect(deps?.improve).toBe(runtime.improve.improve);
    expect(deps?.delegate).toBeDefined();
    expect(deps?.model).toEqual({ provider: f.deps.configManager.loadConfig().provider, model: f.deps.configManager.loadConfig().model });
    // The core store's SQLite URL is the wrapper's, never the app's: with no postgres DATABASE_URL
    // the orchestrator is told nothing, so the app keeps its in-process store rather than being
    // handed a `file:` URL its postgresql client cannot take (`headless.app-store.test.ts`).
    expect(deps?.databaseUrl).toBeUndefined();
  });

  it("carries model_overrides from config to the orchestrator, and on to the gateway's env bridge", async () => {
    // The orchestrator builds its model gateway with no arguments, so a configured price reaches it
    // only if the runtime hands the block over and `applyModelEnv` writes the bridge — the same road
    // the privacy block takes. Without this line `model_overrides` is config that does nothing.
    const OVERRIDES = { "my-private-finetune": { input_cents_per_million: 7, output_cents_per_million: 21 } };
    const guarded = ["TRENT_MODEL_OVERRIDES", "MODEL_PREFERRED_PROVIDER", "GOOGLE_MODEL_FAST", "GOOGLE_MODEL_DEFAULT", "GOOGLE_MODEL_STRONG"];
    const saved = new Map(guarded.map((name) => [name, process.env[name]]));
    for (const name of guarded) delete process.env[name];

    try {
      const f = fakes((manager) => {
        const config = manager.loadConfig();
        config.model_overrides = OVERRIDES;
        manager.saveConfig(config);
      });
      await createHeadlessRuntime(f.deps);

      expect(f.received[0]?.model?.overrides).toEqual(OVERRIDES);

      const { applyModelEnv } = await import("@trent/core/orchestrator/index.js");
      const report = applyModelEnv(f.received[0]?.model);
      expect(report.written).toContain("TRENT_MODEL_OVERRIDES");
      expect(JSON.parse(process.env.TRENT_MODEL_OVERRIDES ?? "{}")).toEqual(OVERRIDES);
    } finally {
      for (const [name, value] of saved) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it("leaves the model dep exactly provider+model when no override is configured", async () => {
    const f = fakes();
    await createHeadlessRuntime(f.deps);
    expect(f.received[0]?.model).toEqual({
      provider: f.deps.configManager.loadConfig().provider,
      model: f.deps.configManager.loadConfig().model,
    });
  });

  // [B2.1] model tiers
  it("carries the configured model tiers to the orchestrator, so each tier resolves its own model", async () => {
    // B2's tier mapping reached `fleet show` through passthrough and stopped there: this file
    // forwarded provider, model and model_overrides only, so a live run still wrote ONE model into
    // every tier variable and every seat ran it whatever its manifest tier said.
    const TIERS = { fast: "gemini-3.5-flash-lite", executor: "gemini-3.6-flash", planner: "gemini-3.6-pro" };
    await withCleanEnv(GOOGLE_TIER_VARS, async () => {
      const f = fakes((manager) => {
        const config = manager.loadConfig();
        config.models = { ...TIERS };
        manager.saveConfig(config);
      });
      await createHeadlessRuntime(f.deps);
      expect((f.received[0]?.model as ModelTiers | undefined)?.models).toEqual(TIERS);

      const { applyModelEnv } = await import("@trent/core/orchestrator/index.js");
      applyModelEnv(f.received[0]?.model);
      expect(process.env.GOOGLE_MODEL_FAST).toBe(TIERS.fast);
      expect(process.env.GOOGLE_MODEL_DEFAULT).toBe(TIERS.executor);
      expect(process.env.GOOGLE_MODEL_STRONG).toBe(TIERS.planner);
      expect(process.env.GOOGLE_MODEL_STRONG).not.toBe(process.env.GOOGLE_MODEL_DEFAULT);
    });
  });

  it("names the critic's own model when models.judge is set on a provider that has a critic variable", async () => {
    const TIERS = { executor: "gpt-5.6-terra", planner: "gpt-5.6-strong", judge: "gpt-5.6-judge" };
    await withCleanEnv(OPENAI_TIER_VARS, async () => {
      const f = fakes((manager) => {
        const config = manager.loadConfig();
        config.provider = "openai";
        config.models = { ...TIERS };
        manager.saveConfig(config);
      });
      await createHeadlessRuntime(f.deps);

      const { applyModelEnv } = await import("@trent/core/orchestrator/index.js");
      applyModelEnv(f.received[0]?.model);
      expect(process.env.OPENAI_MODEL_STRONG).toBe(TIERS.planner);
      expect(process.env.OPENAI_MODEL_CRITIC).toBe(TIERS.judge);
    });
  });

  it("writes exactly what the single model wrote before when no tiers are configured", async () => {
    // The byte-identical guarantee: an untiered profile must reach the same variables with the
    // same values it did before the key existed, or this is a behaviour change nobody asked for.
    await withCleanEnv(GOOGLE_TIER_VARS, async () => {
      const f = fakes();
      await createHeadlessRuntime(f.deps);
      const loaded = f.deps.configManager.loadConfig();
      const { applyModelEnv } = await import("@trent/core/orchestrator/index.js");

      const forwarded = applyModelEnv(f.received[0]?.model);
      const after = GOOGLE_TIER_VARS.map((name) => [name, process.env[name]]);
      for (const name of GOOGLE_TIER_VARS) delete process.env[name];
      const single = applyModelEnv({ provider: loaded.provider, model: loaded.model });

      expect(GOOGLE_TIER_VARS.map((name) => [name, process.env[name]])).toEqual(after);
      expect(forwarded.written).toEqual(single.written);
      expect(f.received[0]?.model).toEqual({ provider: loaded.provider, model: loaded.model });
    });
  });

  it("cleanup() releases the tools (adapters and the proxy) exactly once", async () => {
    const f = fakes();
    const runtime = await createHeadlessRuntime(f.deps);

    await runtime.cleanup();
    await runtime.cleanup();
    expect(f.adapterCleanup).toHaveBeenCalledTimes(1);
    expect(f.egressStop).toHaveBeenCalledTimes(1);
  });

  it("a configured company id is trusted and nothing is ensured", async () => {
    const f = fakes((manager) => {
      const config = manager.loadConfig() as unknown as { company?: { id?: string } };
      config.company = { id: "cmp_configured" };
      manager.saveConfig(config as never);
    });
    const runtime = await createHeadlessRuntime(f.deps);
    runtimes.push(runtime);
    expect(runtime.companyId).toBe("cmp_configured");
    expect(f.ensureCompany).not.toHaveBeenCalled();
  });
});

describe("createHeadlessRuntime bus hooks", () => {
  it("an injected bus hook is composed onto the orchestrator's hook, so every run's events reach it and its flush is awaited", async () => {
    const seen: OrcEvent["kind"][] = [];
    const flush = vi.fn(async () => undefined);
    const f = fakes();
    const runtime = await createHeadlessRuntime({ ...f.deps, busHooks: [{ sink: (event) => seen.push(event.kind), flush }] });
    runtimes.push(runtime);

    const hook = f.received[0]?.improve;
    expect(hook).toBeDefined();
    expect(hook).not.toBe(runtime.improve.improve);
    // Drive the composed hook the way the orchestrator does: every event, then one flush.
    for (const event of EVENTS) hook!.sink(event);
    await hook!.flush();
    expect(seen).toEqual(["run_start", "run_done"]);
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it("with no bus hooks injected the improve hook still goes to the orchestrator unwrapped", async () => {
    const f = fakes();
    const runtime = await createHeadlessRuntime({ ...f.deps, busHooks: [] });
    runtimes.push(runtime);
    expect(f.received[0]?.improve).toBe(runtime.improve.improve);
  });
});

describe("createHeadlessRuntime alerts", () => {
  it("with gateway.owner set and an alert sender injected, a run_failed event becomes one message to the owner", async () => {
    const f = fakes((manager) => {
      const config = manager.loadConfig();
      config.gateway.owner = { platform: "telegram", channelId: "555" };
      manager.saveConfig(config);
    });
    const send = vi.fn(async () => ({ queued: "q1", sent: true }));
    const runtime = await createHeadlessRuntime({ ...f.deps, alerts: { manager: { send } } });
    runtimes.push(runtime);
    expect(runtime.alerts?.active).toBe(true);

    const hook = f.received[0]?.improve;
    expect(hook).toBeDefined();
    hook!.sink(ev("run_start", { run: { objective: "hello" } }));
    hook!.sink(ev("run_failed", { detail: "the model gateway returned 503" }));
    await hook!.flush();
    expect(send).toHaveBeenCalledTimes(1);
    const [platform, message] = send.mock.calls[0] as unknown as [string, { channelId: string; text: string }];
    expect(platform).toBe("telegram");
    expect(message.channelId).toBe("555");
    expect(message.text).toContain("run_h");
    expect(message.text).toContain("the model gateway returned 503");
  });

  it("with no gateway.owner the alert hook is inert and the sender is never called", async () => {
    const f = fakes();
    const send = vi.fn(async () => ({ queued: "q1", sent: true }));
    const runtime = await createHeadlessRuntime({ ...f.deps, alerts: { manager: { send } } });
    runtimes.push(runtime);
    expect(runtime.alerts?.active).toBe(false);
    const hook = f.received[0]?.improve;
    hook!.sink(ev("run_failed", { detail: "boom" }));
    await hook!.flush();
    expect(send).not.toHaveBeenCalled();
  });

  it("with no alert sender injected no alert hook is built", async () => {
    const f = fakes();
    const runtime = await createHeadlessRuntime(f.deps);
    runtimes.push(runtime);
    expect(runtime.alerts).toBeUndefined();
  });
});

describe("createHeadlessRuntime telemetry", () => {
  it("with no telemetry.otlp_endpoint the improve hook goes to the orchestrator unwrapped and no exporter is built", async () => {
    const f = fakes();
    const runtime = await createHeadlessRuntime(f.deps);
    runtimes.push(runtime);
    expect(runtime.telemetry).toBeUndefined();
    expect(f.received[0]?.improve).toBe(runtime.improve.improve);
  });

  it("with telemetry.otlp_endpoint set, the run's events reach both the improve loop and an OTel export to that endpoint", async () => {
    const { default: http } = await import("node:http");
    const bodies: string[] = [];
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });
      req.on("end", () => {
        bodies.push(body);
        res.writeHead(200);
        res.end("{}");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };
    const endpoint = `http://127.0.0.1:${port}/v1/traces`;
    try {
      const f = fakes((manager) => {
        const config = manager.loadConfig();
        manager.saveConfig({ ...config, telemetry: { otlp_endpoint: endpoint, service_name: "trent-headless-test" } });
      });
      const runtime = await createHeadlessRuntime(f.deps);
      runtimes.push(runtime);

      expect(runtime.telemetry?.exporter.getEndpoint()).toBe(endpoint);
      const hook = f.received[0]?.improve;
      expect(hook).toBeDefined();
      expect(hook).not.toBe(runtime.improve.improve);

      // Drive the composed hook the way the orchestrator does: every event, then one flush.
      for (const event of EVENTS) hook!.sink(event);
      await hook!.flush();

      expect(bodies).toHaveLength(1);
      const payload = JSON.parse(bodies[0]!) as {
        resourceSpans: Array<{ resource: { attributes: Array<{ key: string; value: { stringValue: string } }> }; scopeSpans: Array<{ spans: Array<{ name: string }> }> }>;
      };
      expect(payload.resourceSpans[0]?.resource.attributes).toContainEqual({ key: "service.name", value: { stringValue: "trent-headless-test" } });
      expect(payload.resourceSpans[0]?.scopeSpans[0]?.spans.map((s) => s.name)).toEqual(["trent.run"]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("createHeadlessRuntime version pins (T4.1)", () => {
  it("with a store that carries the improve tables, run_start pins every live agent version through the composed hook", async () => {
    const { InMemoryImproveStore } = await import("@trent/core/improve/index.js");
    const { createAgentVersions } = await import("@trent/core/fleet/index.js");
    const improve = new InMemoryImproveStore();
    const versions = createAgentVersions({
      store: improve,
      companyId: COMPANY_ID,
      source: { definition: async (agentId) => ({ prompt: `You are ${agentId}.`, model: { provider: "anthropic", model: "m" }, toolsets: ["file_ops"], skills: [] }) },
    });
    const v1 = await versions.createCandidate("engineer");
    await versions.promote("engineer", 1, { actor: "human" });

    const f = fakes();
    const store = Object.assign(f.store, { improve: () => improve });
    const runtime = await createHeadlessRuntime({ ...f.deps, openStore: async () => ({ store: store as unknown as ReplStore, durable: true }) });
    runtimes.push(runtime);
    expect(runtime.versionPins).toBeDefined();

    const hook = f.received[0]?.improve;
    expect(hook).not.toBe(runtime.improve.improve);
    hook!.sink(ev("run_start", { run: { companyId: COMPANY_ID, objective: "hello" } }));
    await hook!.flush();
    expect(runtime.versionPins?.pinnedFor("run_h")).toEqual({ engineer: v1.id });
  });

  it("without the improve tables no pin hook is built", async () => {
    const f = fakes();
    const runtime = await createHeadlessRuntime(f.deps);
    runtimes.push(runtime);
    expect(runtime.versionPins).toBeUndefined();
  });
});

// ── A2.1 workspace context, A2.2 session hooks ──────────────────────────────

/** A fact no other part of the prelude can produce, so finding it proves the file was read. */
const WORKSPACE_FACT = "The partner API allows sixty requests a minute.";

/** A workspace with one instruction file. Outside any git repository, so the root is the directory. */
function workspaceWith(text: string): string {
  const dir = mkdtempSync(path.join(home, "ws-"));
  writeFileSync(path.join(dir, "AGENTS.md"), `# House rules\n\n${text}\n`);
  return dir;
}

/** One seat call through the hook the runtime built: what the stable tier held, and which blocks survived. */
async function preludeOf(runtime: HeadlessRuntime): Promise<{ stable: string; blocks: string[] }> {
  const hook = runtime.fleetMemory;
  hook.runStarted({ runId: "run_ws", companyId: COMPANY_ID, objective: "read the house rules" });
  const seat = hook.wrapSeatModel(async (input: { subtask: { id: string; seat: string; objective: string } }) => input);
  await seat({ subtask: { id: "s1", seat: "engineer", objective: "read the house rules" } });
  return {
    stable: hook.stablePreludeFor("run_ws") ?? "",
    blocks: (hook.contextFor("run_ws", "engineer")?.kept ?? []).map((block) => block.name),
  };
}

describe("createHeadlessRuntime and the workspace's instruction files", () => {
  it("an untrusted workspace contributes no block, and the runtime carries the line that would trust it", async () => {
    const f = fakes();
    const runtime = await createHeadlessRuntime({ ...f.deps, workspace: workspaceWith(WORKSPACE_FACT) });
    runtimes.push(runtime);

    expect(runtime.workspace.trusted).toBe(false);
    expect(runtime.workspace.instruction).toContain("trent workspace trust");
    const { stable, blocks } = await preludeOf(runtime);
    expect(stable).not.toContain(WORKSPACE_FACT);
    expect(blocks).not.toContain(CONTEXT_BLOCKS.workspace);
  });

  it("a trusted workspace's AGENTS.md text lands in the STABLE tier of the assembled prelude", async () => {
    const f = fakes();
    const workspace = workspaceWith(WORKSPACE_FACT);
    trustWorkspace({ cwd: workspace, profileDir: f.deps.configManager.getProfileDir() });
    const runtime = await createHeadlessRuntime({ ...f.deps, workspace });
    runtimes.push(runtime);

    expect(runtime.workspace.trusted).toBe(true);
    const { stable, blocks } = await preludeOf(runtime);
    expect(stable).toContain(WORKSPACE_FACT);
    expect(stable).toContain("AGENTS.md");
    expect(blocks).toContain(CONTEXT_BLOCKS.workspace);
  });
});

/** Appends the JSON document it was given on stdin to the file named in argv. */
const RECORD_FIXTURE = `let d = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => { d += c; });
process.stdin.on("end", () => { require("node:fs").appendFileSync(process.argv[2], d); process.exit(0); });
`;

interface SessionHookFixture {
  readonly start: HookSpec;
  readonly stop: HookSpec;
  readonly startFile: string;
  readonly stopFile: string;
}

function sessionHooks(): SessionHookFixture {
  const dir = mkdtempSync(path.join(home, "hooks-"));
  const script = path.join(dir, "record.cjs");
  writeFileSync(script, RECORD_FIXTURE);
  const startFile = path.join(dir, "start.json");
  const stopFile = path.join(dir, "stop.json");
  return {
    start: { command: [process.execPath, script, startFile] },
    stop: { command: [process.execPath, script, stopFile] },
    startFile,
    stopFile,
  };
}

function withSessionHooks(fixture: SessionHookFixture): (manager: ConfigManager) => void {
  return (manager) => {
    const config = manager.loadConfig();
    config.hooks = { pre_tool_call: [], post_tool_call: [], session_start: [fixture.start], session_stop: [fixture.stop] };
    manager.saveConfig(config);
  };
}

describe("createHeadlessRuntime and the session hooks", () => {
  it("runs a consented session_start hook when the session opens, and session_stop on cleanup", async () => {
    const fixture = sessionHooks();
    const f = fakes(withSessionHooks(fixture));
    writeConsent(f.deps.configManager.getProfileDir(), [
      hookSpecHash("session_start", fixture.start),
      hookSpecHash("session_stop", fixture.stop),
    ]);

    const runtime = await createHeadlessRuntime(f.deps);
    expect(existsSync(fixture.startFile)).toBe(true);
    expect(JSON.parse(readFileSync(fixture.startFile, "utf8")).hook).toBe("session_start");
    // The session is open: nothing has told the stop hook otherwise.
    expect(existsSync(fixture.stopFile)).toBe(false);

    await runtime.cleanup();
    expect(JSON.parse(readFileSync(fixture.stopFile, "utf8")).hook).toBe("session_stop");
  });

  it("an unconsented session hook never runs, and the runtime reports it once", async () => {
    const fixture = sessionHooks();
    const f = fakes(withSessionHooks(fixture));
    const runtime = await createHeadlessRuntime(f.deps);
    runtimes.push(runtime);

    expect(existsSync(fixture.startFile)).toBe(false);
    const notices = runtime.notices();
    expect(notices.filter((line) => line.includes("session_start"))).toHaveLength(1);
    expect(notices.join("\n")).toContain("trent hooks consent");
  });
});
