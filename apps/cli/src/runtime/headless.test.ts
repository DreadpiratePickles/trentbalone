/**
 * The headless session runtime: the object graph the REPL builds (store, tools, fleet memory, the
 * improve loop, the orchestrator, the company) with no terminal attached. Every collaborator that
 * would touch a daemon, a proxy or a model is injected here; what is under test is the wiring.
 */

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ConfigManager } from "@trent/core";
import type { OrcEvent, Orchestrator, OrchestratorDepsWithImprove } from "@trent/core/orchestrator/index.js";
import type { TrentToolAdapter } from "@trent/core/tools/index.js";
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
    expect(deps?.databaseUrl).toBe(`file:${f.deps.configManager.getProfileDir()}/trent.db`);
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
