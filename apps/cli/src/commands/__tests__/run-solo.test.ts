/**
 * [S2] `trent run --solo "<objective>"`: the one-shot path on the solo runner. The runtime is the REAL
 * headless runtime with its seams filled (a fake orchestrator that must never run, fake tools, a
 * scripted model), so what is asserted is the command's contract on solo: the flag reaches the
 * runtime, the fake model's answer completes the run with exit 0, and the result carries the mode.
 * `trent run` without a terminal has no human to decide a held call, so the call is refused (B8).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigManager } from "@trent/core/config/index.js";
import { EXIT } from "@trent/core/errors/index.js";
import type { Orchestrator } from "@trent/core/orchestrator/index.js";
import { fakeAdapter, scriptedGateway, toolCall, type FakeAdapter, type ScriptedGateway } from "@trent/core/solo/fakes.test-helpers.js";
import { MemoryStore } from "../../repl/__tests__/harness.js";
import type { ReplStore } from "../../repl/types.js";
import { createHeadlessRuntime, type HeadlessRuntimeDeps } from "../../runtime/headless.js";
import type { CliOverrides } from "../context.js";
import { runCli } from "../index.js";

const REPO_ROOT = path.resolve(__dirname, "../../../../..");
const POST = 'social_post {"platform": "bluesky", "text": "The launch email is out."}';
let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "trent-cli-run-solo-"));
  process.env.TRENT_HOME = home;
  const manager = new ConfigManager({ profile: "default" });
  const config = manager.loadConfig();
  manager.updateConfig({ ...config, provider: "google", model: "gemini-test", terminal: { ...config.terminal, backend: "local" } });
});
afterEach(() => {
  delete process.env.TRENT_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

interface Fixture {
  overrides: CliOverrides;
  built: HeadlessRuntimeDeps[];
  gateway: ScriptedGateway;
  social: FakeAdapter;
  fleetRuns: string[];
}

function fixture(script: string[]): Fixture {
  const built: HeadlessRuntimeDeps[] = [];
  const fleetRuns: string[] = [];
  const gateway = scriptedGateway(script);
  const social = fakeAdapter({ name: "social", tools: ["social_post"], approval: (action) => action.startsWith("social_post") });
  const createOrchestrator = (): Orchestrator =>
    ({
      ensureCompany: async () => "cmp_run_solo",
      run: (options: { objective: string }) => {
        fleetRuns.push(options.objective);
        throw new Error("the fleet must not run under --solo");
      },
      snapshot: async () => undefined,
      approve: async () => true,
      reject: async () => true,
    }) as unknown as Orchestrator;
  const overrides: CliOverrides = {
    gatewayRuntime: async (deps) => {
      built.push(deps);
      return createHeadlessRuntime({
        ...deps,
        workspace: REPO_ROOT,
        createOrchestrator,
        buildAdapters: () => [social],
        startEgress: async () => ({ port: 1, url: "http://127.0.0.1:1", token: "t", caCertPath: "/dev/null", isListening: () => true, stop: async () => undefined }),
        probeDocker: async () => ({ daemon: false, imagePresent: false }),
        openStore: async () => ({ store: new MemoryStore() as unknown as ReplStore, durable: true }),
        solo: { gateway, audit: async () => undefined },
      });
    },
  };
  return { overrides, built, gateway, social, fleetRuns };
}

describe("[S2] trent run --solo", () => {
  it("runs the solo runner: the fake model answers, exit 0, and the JSON carries mode solo", async () => {
    const f = fixture(["The launch email is drafted."]);
    const result = await runCli(["run", "--solo", "Draft the launch email", "--json"], { overrides: f.overrides });
    expect(result.exitCode).toBe(EXIT.OK);
    const json = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(json).toMatchObject({ type: "result", status: "completed", mode: "solo", model: "gemini-test", models: ["gemini-test"] });
    expect(String(json.run_id)).toMatch(/^solo_/);
    expect(f.built[0]?.mode).toBe("solo");
    expect(f.fleetRuns).toEqual([]);
    expect(f.gateway.requests).toHaveLength(1);
  });

  it("stream-json: the system line and the result name the mode; the events are the solo run's own", async () => {
    const f = fixture(["Done."]);
    const result = await runCli(["run", "--solo", "Say done", "--format", "stream-json"], { overrides: f.overrides });
    expect(result.exitCode).toBe(EXIT.OK);
    const lines = result.stdout.trim().split("\n").map((line) => JSON.parse(line) as { type: string; mode?: string; step?: { agentRole?: string } });
    expect(lines[0]).toMatchObject({ type: "system", mode: "solo" });
    expect(lines.map((line) => line.type).slice(1, -1)).toEqual(["run_start", "step_start", "step_output", "step_end", "run_done"]);
    expect(lines[2]?.step?.agentRole).toBe("trent");
    expect(lines.at(-1)).toMatchObject({ type: "result", status: "completed", mode: "solo" });
  });

  it("agent.mode solo in config is honoured without the flag", async () => {
    const manager = new ConfigManager({ profile: "default" });
    manager.updateConfig({ ...manager.loadConfig(), agent: { mode: "solo" } } as never);
    const f = fixture(["From config."]);
    const result = await runCli(["run", "From config", "--json"], { overrides: f.overrides });
    expect(result.exitCode).toBe(EXIT.OK);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "completed", mode: "solo" });
    expect(f.built[0]?.mode).toBeUndefined();
  });

  it("B8: without a terminal a held call is refused, never parked: no dryRun, no post, exit 0", async () => {
    const f = fixture([toolCall(POST), "I could not send it: nobody is here to approve it."]);
    const result = await runCli(["run", "--solo", "Send the launch email", "--json"], { overrides: f.overrides });
    expect(result.exitCode).toBe(EXIT.OK);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "completed", mode: "solo" });
    expect(f.social.dryRuns).toEqual([]);
    expect(f.social.calls).toEqual([]);
  });

  it("--resume is the fleet's (a killed process's run); on solo it is refused before anything is built", async () => {
    const f = fixture([]);
    const result = await runCli(["run", "--solo", "--resume", "solo_1", "--json"], { overrides: f.overrides });
    expect(result.exitCode).toBe(EXIT.USAGE);
    expect(result.stdout).toContain("--resume");
    expect(f.built).toEqual([]);
  });
});
