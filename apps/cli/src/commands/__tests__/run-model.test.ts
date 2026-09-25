/**
 * [P2-1] `trent run --model <id>`: the whole run on one model, and the run's records say so.
 *
 * The runtime here is the REAL headless runtime (`createHeadlessRuntime`), the spend ledger is the
 * real one under a scratch TRENT_HOME, and the model env bridge is the real `applyModelEnv`. Only the
 * orchestrator is a stand-in, and it behaves as the real one does where the model is concerned: it
 * applies its `model` dep to the environment first, then each seat reports the model its tier
 * variable holds (`resolveSeatModel`, the variable the app's `resolveModelName` reads). So a step's
 * `model` is whatever the environment says, never what the test wrote, and the control case shows
 * the same profile spreading over its tier models when no pin is given.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigManager } from "@trent/core/config/index.js";
import { EXIT } from "@trent/core/errors/index.js";
import {
  applyModelEnv,
  type OrcEvent,
  type Orchestrator,
  type OrchestratorDepsWithImprove,
} from "@trent/core/orchestrator/index.js";
import { resolveSeatModel } from "@trent/core/orchestrator/model-env.js";
import { closeRunScope, openRunScope } from "@trent/core/orchestrator/run-hooks.js";
import type { TrentToolAdapter } from "@trent/core/tools/index.js";
import { MemoryStore } from "../../repl/__tests__/harness.js";
import type { EgressHandle } from "../../repl/tools.js";
import type { ReplStore } from "../../repl/types.js";
import { createHeadlessRuntime, type HeadlessRuntimeDeps } from "../../runtime/headless.js";
import type { CliOverrides } from "../context.js";
import { runCli } from "../index.js";

const REPO_ROOT = path.resolve(__dirname, "../../../../..");
const PIN = "gemini-3.6-flash";
const CONFIGURED = "gemini-3.5-flash-lite";
const TIERS = { fast: "gemini-3.5-flash-lite", executor: "gemini-3.5-flash", planner: "gemini-3.6-pro" };
/** One seat per manifest tier: opus, sonnet, haiku. */
const SEATS = ["ceo", "engineer", "support"] as const;
const MODEL_KEYS = [
  "MODEL_PREFERRED_PROVIDER",
  "MODEL_ALLOWED_PROVIDERS",
  "GOOGLE_MODEL_FAST",
  "GOOGLE_MODEL_DEFAULT",
  "GOOGLE_MODEL_STRONG",
  "WORKBENCH_PLANNER_MODEL",
  "WORKBENCH_EXECUTOR_MODEL",
  "TRENT_MODEL_FALLBACK_ON_PIN",
] as const;

let home: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "trent-cli-run-model-"));
  process.env.TRENT_HOME = home;
  for (const key of MODEL_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  const manager = new ConfigManager({ profile: "default" });
  const config = manager.loadConfig();
  config.terminal.backend = "local";
  manager.updateConfig({ ...config, provider: "google", model: CONFIGURED, models: { ...config.models, ...TIERS } });
});

afterEach(() => {
  delete process.env.TRENT_HOME;
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(home, { recursive: true, force: true });
});

/** The orchestrator stand-in: env first, as `createOrchestrator` does, then one billed step per seat. */
function appLikeOrchestrator(deps: OrchestratorDepsWithImprove = {}): Orchestrator {
  applyModelEnv(deps.model);
  let n = 0;
  return {
    run: (options) => {
      n += 1;
      const runId = `run_model_${n}`;
      const iterable = (async function* () {
        openRunScope([], runId, options);
        try {
          const events: OrcEvent[] = [
            { kind: "run_start", runId, at: "2026-09-25T10:00:00.000Z", run: { objective: options.objective, status: "planning" } },
            ...SEATS.map((seat, index): OrcEvent => ({
              kind: "step_end",
              runId,
              at: "2026-09-25T10:00:01.000Z",
              step: { id: `stp_${index}`, agentRole: seat, status: "completed", model: resolveSeatModel(seat, deps.model), tokens: 100, costCents: 2 },
            })),
            { kind: "run_done", runId, at: "2026-09-25T10:00:02.000Z", run: { status: "completed", summary: "ready" } },
          ];
          for (const event of events) {
            deps.traceSink?.(event);
            yield event;
          }
        } finally {
          closeRunScope([], runId);
        }
      })();
      return Object.assign(iterable, { runId, started: Promise.resolve(runId), result: async () => { throw new Error("iterate instead"); }, cancel: async () => false });
    },
    ensureCompany: async () => "cmp_model",
    snapshot: async () => undefined,
    approve: async () => true,
    reject: async () => true,
  };
}

function overrides(built: HeadlessRuntimeDeps[]): CliOverrides {
  const adapter = { name: "fake_tool", scopes: ["read"], instructions: "", routingText: "", execute: async () => ({ ok: true, output: "" }), cleanup: vi.fn(async () => undefined) } as unknown as TrentToolAdapter;
  const egress: EgressHandle = { port: 1, url: "http://127.0.0.1:1", token: "t", caCertPath: "/dev/null", isListening: () => true, stop: async () => undefined };
  return {
    gatewayRuntime: (deps) => {
      built.push(deps);
      return createHeadlessRuntime({
        ...deps,
        workspace: REPO_ROOT,
        createOrchestrator: appLikeOrchestrator,
        buildAdapters: () => [adapter],
        startEgress: async () => egress,
        probeDocker: async () => ({ daemon: false, imagePresent: false }),
        openStore: async () => ({ store: new MemoryStore() as unknown as ReplStore, durable: true }),
      });
    },
  };
}

function jsonl(stdout: string): Array<Record<string, unknown>> {
  return stdout.split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function usageByModel(): Promise<Array<{ key: string; cents: number }>> {
  const usage = await runCli(["usage", "--json", "--by", "model"]);
  expect(usage.exitCode).toBe(EXIT.OK);
  return (JSON.parse(usage.stdout) as { today: { groups: Array<{ key: string; cents: number }> } }).today.groups;
}

describe("[P2-1] trent run --model", () => {
  it("control: without --model a tiered profile's steps spread over its tier models", async () => {
    const result = await runCli(["run", "Say the word ready and nothing else", "--format", "stream-json"], { overrides: overrides([]) });
    expect(result.exitCode).toBe(EXIT.OK);
    const models = new Set(jsonl(result.stdout).filter((line) => line.type === "step_end").map((line) => (line.step as { model?: string }).model));
    expect(models.size).toBeGreaterThan(1);
    expect(models.has(PIN)).toBe(false);
  });

  it("--model names the model in every step's model field and the run's ledger rows", async () => {
    // An operator's own shell value that the pin must beat.
    process.env.GOOGLE_MODEL_STRONG = "gemini-2.5-pro";
    const built: HeadlessRuntimeDeps[] = [];
    const result = await runCli(["run", "Say the word ready and nothing else", "--model", PIN, "--format", "stream-json"], { overrides: overrides(built) });
    expect(result.exitCode).toBe(EXIT.OK);
    expect(built.map((deps) => deps.model)).toEqual([PIN]);

    const lines = jsonl(result.stdout);
    expect(lines[0]).toMatchObject({ type: "system", provider: "google", model: PIN });
    const steps = lines.filter((line) => line.type === "step_end").map((line) => line.step as { agentRole: string; model?: string });
    expect(steps.map((step) => step.agentRole)).toEqual([...SEATS]);
    for (const step of steps) expect(step.model, step.agentRole).toBe(PIN);
    expect(lines.at(-1)).toMatchObject({ type: "result", status: "completed", model: PIN, models: [PIN], cost_cents: 6 });

    const groups = await usageByModel();
    expect(groups).toEqual([expect.objectContaining({ key: PIN, cents: 6 })]);
  });

  it("--json carries the model that was asked for and the models the steps ran on", async () => {
    const result = await runCli(["run", "Say the word ready and nothing else", "--model", PIN, "--json"], { overrides: overrides([]) });
    expect(result.exitCode).toBe(EXIT.OK);
    expect(JSON.parse(result.stdout)).toMatchObject({ type: "result", status: "completed", model: PIN, models: [PIN] });
  });

  it("a malformed --model is a configuration error before any runtime is built; --dry-run reports the pin", async () => {
    const built: HeadlessRuntimeDeps[] = [];
    const bad = await runCli(["run", "hello", "--model", "gemini 3.6", "--json"], { overrides: overrides(built) });
    expect(bad.exitCode).toBe(EXIT.CONFIG);
    expect(built).toEqual([]);

    const dry = await runCli(["run", "hello", "--model", PIN, "--dry-run", "--json"]);
    expect(dry.exitCode).toBe(EXIT.OK);
    expect(JSON.parse(dry.stdout)).toMatchObject({ dryRun: true, command: "run", model: PIN });
  });
});
