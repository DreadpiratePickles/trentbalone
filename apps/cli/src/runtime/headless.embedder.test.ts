/**
 * [L1] (for L0-5, G10) The profile's `memory.embedder` reaches the model env a real run prepares.
 *
 * `applyModelEnv` writes `EMBEDDING_MODEL` for the app's own embedding calls from `memory.embedder`
 * (`fleet-memory/embedder-local.ts` `applyAppEmbeddingEnv`), but only from what the caller hands it. The
 * headless runtime built the orchestrator's model config from provider, model, prices and tiers, without
 * `memory`, so under a local embedder the app's per-step wiki search still asked the runtime for
 * `text-embedding-3-small` and got a 404. The fake orchestrator here does what the real one does first
 * (`orchestrator/index.ts`: `applyModelEnv(deps.model)`). Nothing opens a socket, a sandbox or a model.
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigManager } from "@trent/core";
import { applyModelEnv, type ModelEnvConfig } from "@trent/core/orchestrator/model-env.js";
import type { OrcEvent, Orchestrator, OrchestratorDepsWithImprove } from "@trent/core/orchestrator/index.js";
import type { TrentToolAdapter } from "@trent/core/tools/index.js";
import { MemoryStore } from "../repl/__tests__/harness.js";
import type { ReplStore } from "../repl/types.js";
import type { EgressHandle } from "../repl/tools.js";
import { createHeadlessRuntime, type HeadlessRuntime } from "./headless.js";

const REPO_ROOT = path.resolve(__dirname, "../../../..");
let home = "";
const savedHome = process.env.TRENT_HOME;
let savedEnv: NodeJS.ProcessEnv = {};

beforeAll(() => {
  home = mkdtempSync(path.join(os.tmpdir(), "trent-headless-embedder-"));
  process.env.TRENT_HOME = home;
});
afterAll(() => {
  if (savedHome === undefined) delete process.env.TRENT_HOME;
  else process.env.TRENT_HOME = savedHome;
  rmSync(home, { recursive: true, force: true });
});

const runtimes: HeadlessRuntime[] = [];
beforeEach(() => {
  savedEnv = { ...process.env };
  for (const name of ["EMBEDDING_MODEL", "OPENAI_BASE_URL", "OPENAI_API_KEY", "OLLAMA_BASE_URL", "TRENT_MODEL_ALIAS"]) delete process.env[name];
});
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.cleanup();
  for (const name of Object.keys(process.env)) if (!(name in savedEnv)) delete process.env[name];
  for (const [name, value] of Object.entries(savedEnv)) if (value !== undefined) process.env[name] = value;
});

async function runtimeWith(embedder: Record<string, string> | undefined): Promise<OrchestratorDepsWithImprove[]> {
  const configManager = new ConfigManager({ profile: `embed-${Math.random().toString(36).slice(2, 8)}` });
  const config = configManager.loadConfig();
  config.terminal.backend = "local";
  config.provider = "ollama";
  config.model = "qwen3.5:9b";
  if (embedder !== undefined) (config as unknown as { memory: Record<string, unknown> }).memory = { ...config.memory, embedder };
  configManager.saveConfig(config);
  const seen: OrchestratorDepsWithImprove[] = [];
  const createOrchestrator = (deps: OrchestratorDepsWithImprove = {}): Orchestrator => {
    seen.push(deps);
    applyModelEnv(deps.model as ModelEnvConfig); // what createOrchestrator does before anything else
    return {
      run: () =>
        Object.assign(
          (async function* (): AsyncGenerator<OrcEvent> {
            yield { kind: "run_done", runId: "run_1", at: "2026-09-26T10:00:00.000Z", run: { status: "completed", summary: "ready" } };
          })(),
          { runId: "run_1", started: Promise.resolve("run_1"), result: async () => { throw new Error("iterate instead"); }, cancel: async () => false },
        ),
      ensureCompany: async () => "cmp_embed",
      snapshot: async () => undefined,
      approve: async () => true,
      reject: async () => true,
    };
  };
  const adapter = { name: "fake_tool", scopes: ["read"], instructions: "", routingText: "", execute: async () => ({ ok: true, output: "" }), cleanup: vi.fn(async () => undefined) } as unknown as TrentToolAdapter;
  const egress: EgressHandle = { port: 1, url: "http://127.0.0.1:1", token: "t", caCertPath: "/dev/null", isListening: () => true, stop: async () => undefined };
  runtimes.push(
    await createHeadlessRuntime({
      configManager,
      workspace: REPO_ROOT,
      createOrchestrator,
      buildAdapters: () => [adapter],
      startEgress: async () => egress,
      probeDocker: async () => ({ daemon: false, imagePresent: false }),
      openStore: async () => ({ store: new MemoryStore() as unknown as ReplStore, durable: true }),
    }),
  );
  return seen;
}

describe("[L1] memory.embedder travels with the model config", () => {
  it("under memory.embedder.provider ollama the app's EMBEDDING_MODEL is the configured model", async () => {
    const seen = await runtimeWith({ provider: "ollama", model: "qwen3-embedding:0.6b" });
    expect((seen[0]?.model as { memory?: unknown } | undefined)?.memory).toMatchObject({ embedder: { provider: "ollama", model: "qwen3-embedding:0.6b" } });
    expect(process.env.EMBEDDING_MODEL).toBe("qwen3-embedding:0.6b");
  });

  it("the default block (`auto`) under ollama gives the app the local default model; `none` writes nothing", async () => {
    await runtimeWith(undefined);
    expect(process.env.EMBEDDING_MODEL).toBe("qwen3-embedding:0.6b");
    delete process.env.EMBEDDING_MODEL;
    const seen = await runtimeWith({ provider: "none" });
    expect((seen[0]?.model as { memory?: unknown } | undefined)?.memory).toMatchObject({ embedder: { provider: "none" } });
    expect(process.env.EMBEDDING_MODEL).toBeUndefined();
  });
});
