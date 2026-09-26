/**
 * [L0-2] `models.local` reaches the gateway the orchestrator builds with no arguments.
 *
 * The block travels the way `privacy` does: the headless runtime writes it into the env the gateway
 * reads per call (`model-gateway/local-runtime.ts` `LOCAL_MODEL_ENV`), before the orchestrator is
 * built. Without that line the four settings would be accepted by the schema and reach nothing.
 * Nothing here opens a socket, a sandbox or a model.
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ConfigManager } from "@trent/core";
import { LOCAL_MODEL_ENV } from "@trent/core/model-gateway/local-runtime.js";
import type { OrcEvent, Orchestrator } from "@trent/core/orchestrator/index.js";
import type { TrentToolAdapter } from "@trent/core/tools/index.js";
import { MemoryStore } from "../repl/__tests__/harness.js";
import type { ReplStore } from "../repl/types.js";
import type { EgressHandle } from "../repl/tools.js";
import { createHeadlessRuntime, type HeadlessRuntime } from "./headless.js";

const REPO_ROOT = path.resolve(__dirname, "../../../..");
let home = "";
const savedHome = process.env.TRENT_HOME;
const savedEnv = new Map<string, string | undefined>();

beforeAll(() => {
  home = mkdtempSync(path.join(os.tmpdir(), "trent-headless-local-"));
  process.env.TRENT_HOME = home;
  for (const name of Object.values(LOCAL_MODEL_ENV)) savedEnv.set(name, process.env[name]);
});
afterAll(() => {
  if (savedHome === undefined) delete process.env.TRENT_HOME;
  else process.env.TRENT_HOME = savedHome;
  rmSync(home, { recursive: true, force: true });
});

const runtimes: HeadlessRuntime[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.cleanup();
  for (const [name, value] of savedEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

async function runtimeFor(local: Record<string, number> | undefined): Promise<HeadlessRuntime> {
  const configManager = new ConfigManager({ profile: `local-${Math.random().toString(36).slice(2, 8)}` });
  const config = configManager.loadConfig();
  config.terminal.backend = "local";
  config.provider = "ollama";
  config.model = "qwen3.5:9b";
  if (local !== undefined) config.models = { ...config.models, local };
  configManager.saveConfig(config);
  const createOrchestrator = (): Orchestrator => ({
    run: () =>
      Object.assign(
        (async function* (): AsyncGenerator<OrcEvent> {
          yield { kind: "run_done", runId: "run_1", at: "2026-09-26T10:00:00.000Z", run: { status: "completed", summary: "ready" } };
        })(),
        { runId: "run_1", started: Promise.resolve("run_1"), result: async () => { throw new Error("iterate instead"); }, cancel: async () => false },
      ),
    ensureCompany: async () => "cmp_local",
    snapshot: async () => undefined,
    approve: async () => true,
    reject: async () => true,
  });
  const adapter = { name: "fake_tool", scopes: ["read"], instructions: "", routingText: "", execute: async () => ({ ok: true, output: "" }), cleanup: vi.fn(async () => undefined) } as unknown as TrentToolAdapter;
  const egress: EgressHandle = { port: 1, url: "http://127.0.0.1:1", token: "t", caCertPath: "/dev/null", isListening: () => true, stop: async () => undefined };
  const runtime = await createHeadlessRuntime({
    configManager,
    workspace: REPO_ROOT,
    createOrchestrator,
    buildAdapters: () => [adapter],
    startEgress: async () => egress,
    probeDocker: async () => ({ daemon: false, imagePresent: false }),
    openStore: async () => ({ store: new MemoryStore() as unknown as ReplStore, durable: true }),
  });
  runtimes.push(runtime);
  return runtime;
}

describe("[L0-2] the headless runtime bridges models.local", () => {
  it("writes the configured budgets into the env the gateway reads", async () => {
    for (const name of Object.values(LOCAL_MODEL_ENV)) delete process.env[name];
    await runtimeFor({ ttft_seconds: 900, max_in_flight: 2 });
    expect(process.env[LOCAL_MODEL_ENV.ttftSeconds]).toBe("900");
    expect(process.env[LOCAL_MODEL_ENV.maxInFlight]).toBe("2");
    expect(process.env[LOCAL_MODEL_ENV.idleSeconds]).toBeUndefined();
  });

  it("writes nothing for a profile without the block, so the defaults apply", async () => {
    for (const name of Object.values(LOCAL_MODEL_ENV)) delete process.env[name];
    await runtimeFor(undefined);
    for (const name of Object.values(LOCAL_MODEL_ENV)) expect(process.env[name], name).toBeUndefined();
  });
});
