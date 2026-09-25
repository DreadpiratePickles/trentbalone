/**
 * [P2-1] The headless runtime runs on ONE model per process, and says so instead of drifting.
 *
 * `deps.model` is the process's pin (`trent run --model <id>`): it reaches the orchestrator's model
 * config as `pin`, which `applyModelEnv` writes over every model variable before the libs load.
 * `options.model` is one run's model: a run naming the runtime's own pin reaches the orchestrator's
 * run options; a run naming any other model is refused before the orchestrator is called, because
 * the libs froze this process's models and a run on "another model" would silently be this one.
 * Nothing here opens a socket, a sandbox or a model.
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ConfigManager } from "@trent/core";
import { EXIT, TrentError } from "@trent/core/errors/index.js";
import type { OrcEvent, Orchestrator, OrchestratorDepsWithImprove } from "@trent/core/orchestrator/index.js";
import type { TrentToolAdapter } from "@trent/core/tools/index.js";
import { MemoryStore } from "../repl/__tests__/harness.js";
import type { ReplStore } from "../repl/types.js";
import type { EgressHandle } from "../repl/tools.js";
import { createHeadlessRuntime, type HeadlessRuntime, type HeadlessRuntimeDeps } from "./headless.js";

const REPO_ROOT = path.resolve(__dirname, "../../../..");
const PIN = "gemini-3.6-flash";

let home = "";
const savedHome = process.env.TRENT_HOME;
let profileN = 0;

beforeAll(() => {
  home = mkdtempSync(path.join(os.tmpdir(), "trent-headless-model-"));
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

interface Fakes {
  deps: HeadlessRuntimeDeps;
  orchestratorDeps: OrchestratorDepsWithImprove[];
  runOptions: Parameters<Orchestrator["run"]>[0][];
}

function fakes(extra: Partial<HeadlessRuntimeDeps> = {}): Fakes {
  profileN += 1;
  const configManager = new ConfigManager({ profile: `model-${profileN}` });
  const config = configManager.loadConfig();
  config.terminal.backend = "local";
  config.provider = "google";
  config.model = "gemini-3.5-flash-lite";
  configManager.saveConfig(config);

  const orchestratorDeps: OrchestratorDepsWithImprove[] = [];
  const runOptions: Parameters<Orchestrator["run"]>[0][] = [];
  const createOrchestrator = (deps: OrchestratorDepsWithImprove = {}): Orchestrator => {
    orchestratorDeps.push(deps);
    return {
      run: (options) => {
        runOptions.push(options);
        const iterable = (async function* (): AsyncGenerator<OrcEvent> {
          yield { kind: "run_done", runId: "run_1", at: "2026-09-25T10:00:00.000Z", run: { status: "completed", summary: "ready" } };
        })();
        return Object.assign(iterable, { runId: "run_1", started: Promise.resolve("run_1"), result: async () => { throw new Error("iterate instead"); }, cancel: async () => false });
      },
      ensureCompany: async () => "cmp_model",
      snapshot: async () => undefined,
      approve: async () => true,
      reject: async () => true,
    };
  };
  const adapter = { name: "fake_tool", scopes: ["read"], instructions: "", routingText: "", execute: async () => ({ ok: true, output: "" }), cleanup: vi.fn(async () => undefined) } as unknown as TrentToolAdapter;
  const egress: EgressHandle = { port: 1, url: "http://127.0.0.1:1", token: "t", caCertPath: "/dev/null", isListening: () => true, stop: async () => undefined };
  return {
    deps: {
      configManager,
      workspace: REPO_ROOT,
      createOrchestrator,
      buildAdapters: () => [adapter],
      startEgress: async () => egress,
      probeDocker: async () => ({ daemon: false, imagePresent: false }),
      openStore: async () => ({ store: new MemoryStore() as unknown as ReplStore, durable: true }),
      ...extra,
    },
    orchestratorDeps,
    runOptions,
  };
}

async function drain(stream: AsyncIterable<OrcEvent>): Promise<OrcEvent[]> {
  const events: OrcEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

function refusal(action: () => unknown): TrentError {
  try {
    action();
  } catch (error) {
    if (error instanceof TrentError) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

describe("[P2-1] the headless runtime and a per-run model", () => {
  it("a pinned runtime hands the orchestrator its pin, and a run naming it reaches the run options", async () => {
    const f = fakes({ model: PIN, surface: "run" });
    const runtime = await createHeadlessRuntime(f.deps);
    runtimes.push(runtime);

    expect(f.orchestratorDeps).toHaveLength(1);
    expect(f.orchestratorDeps[0]!.model).toMatchObject({ provider: "google", model: "gemini-3.5-flash-lite", pin: PIN });
    expect(runtime.model).toBe(PIN);

    const events = await drain(runtime.run("Say the word ready", { model: PIN }));
    expect(events.map((event) => event.kind)).toEqual(["run_done"]);
    expect(f.runOptions).toHaveLength(1);
    expect(f.runOptions[0]).toMatchObject({ objective: "Say the word ready", surface: "run" });
  });

  it("an unpinned runtime passes no pin at all, and runs an unpinned run as before", async () => {
    const f = fakes({ surface: "run" });
    const runtime = await createHeadlessRuntime(f.deps);
    runtimes.push(runtime);

    expect(f.orchestratorDeps[0]!.model).not.toHaveProperty("pin");
    expect(runtime.model).toBeUndefined();
    await drain(runtime.run("hello"));
    expect(f.runOptions).toHaveLength(1);
  });

  it("a run naming a model this runtime was not built on is refused before the orchestrator is called", async () => {
    const unpinned = fakes({ surface: "cron" });
    const plain = await createHeadlessRuntime(unpinned.deps);
    runtimes.push(plain);
    const first = refusal(() => plain.run("nightly digest", { trigger: "scheduled", model: PIN }));
    expect(first.code).toBe(EXIT.CONFIG);
    expect(first.message).toContain(PIN);
    expect(first.message).toContain("trent run --model");
    expect(unpinned.runOptions).toEqual([]);

    const pinned = fakes({ model: PIN, surface: "run" });
    const other = await createHeadlessRuntime(pinned.deps);
    runtimes.push(other);
    const second = refusal(() => other.run("hello", { model: "gemini-3.5-flash-lite" }));
    expect(second.code).toBe(EXIT.CONFIG);
    expect(pinned.runOptions).toEqual([]);
  });
});
