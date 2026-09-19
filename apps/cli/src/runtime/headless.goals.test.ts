/**
 * D4 — the headless runtime opens the goal session and wires the run-end hook.
 *
 * It is opened in the graph every surface is built on, so `trent run`, the gateway, cron, the
 * heartbeat and the REPL all get quality gates and `verify_on_stop` with no wiring of their own:
 * `/goal` and `trent goal` find the session on the process, the way `/rollback` finds the
 * checkpoint ledger. Nothing here calls a model or starts a container.
 *
 * Its own file rather than `headless.test.ts`, which is already past the 500-line rule.
 */

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ConfigManager } from "@trent/core";
import { activeGoalSession } from "@trent/core/goals/index.js";
import type { OrcEvent, Orchestrator, OrchestratorDepsWithImprove } from "@trent/core/orchestrator/index.js";
import type { TrentToolAdapter } from "@trent/core/tools/index.js";
import { MemoryStore } from "../repl/__tests__/harness.js";
import type { ReplStore } from "../repl/types.js";
import { createHeadlessRuntime, type HeadlessRuntime, type HeadlessRuntimeDeps } from "./headless.js";

const COMPANY_ID = "cmp_goals";

let home = "";
const savedHome = process.env.TRENT_HOME;
let profileN = 0;

beforeAll(() => {
  home = mkdtempSync(path.join(os.tmpdir(), "trent-headless-goals-"));
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

function events(): AsyncIterable<OrcEvent> {
  return (async function* () {
    yield { kind: "run_start", runId: "run_g", at: "2026-09-18T00:00:00.000Z" } as OrcEvent;
  })();
}

interface Fixture {
  readonly deps: HeadlessRuntimeDeps;
  readonly received: OrchestratorDepsWithImprove[];
  readonly profileDir: string;
}

/** A runtime whose only toolset answers to `terminal`, so its calls are candidate evidence. */
function fixture(configure: (config: ReturnType<ConfigManager["loadConfig"]>) => void = () => undefined): Fixture {
  profileN += 1;
  const configManager = new ConfigManager({ profile: `goals-${profileN}` });
  const config = configManager.loadConfig();
  config.terminal.backend = "local";
  configure(config);
  configManager.saveConfig(config);

  const received: OrchestratorDepsWithImprove[] = [];
  const createOrchestrator = (orchestratorDeps: OrchestratorDepsWithImprove = {}): Orchestrator => {
    received.push(orchestratorDeps);
    return {
      run: () => Object.assign(events(), { runId: "run_g", started: Promise.resolve("run_g"), cancel: async () => false }),
      ensureCompany: vi.fn(async () => COMPANY_ID),
      snapshot: async () => undefined,
      approve: async () => true,
      reject: async () => true,
    } as unknown as Orchestrator;
  };

  // Its summary carries the terminal adapter's own non-zero note, which is how an exit code
  // reaches the evidence ledger at all: `ToolCallRecord` has no exit-code field.
  const terminal = {
    name: "terminal",
    scopes: ["terminal"],
    instructions: "",
    routingText: "",
    execute: async (action: string) => ({
      adapter: "terminal",
      action,
      status: "completed",
      summary: action.includes("vitest") ? "1 failed\n[exit code 1]" : "(no output)",
    }),
    cleanup: async () => undefined,
  } as unknown as TrentToolAdapter;

  return {
    deps: {
      configManager,
      workspace: mkdtempSync(path.join(home, "ws-")),
      createOrchestrator,
      buildAdapters: () => [terminal],
      probeDocker: async () => ({ daemon: false, imagePresent: false }),
      openStore: async () => ({ store: new MemoryStore() as unknown as ReplStore, durable: true }),
    },
    received,
    profileDir: configManager.getProfileDir(),
  };
}

describe("the headless runtime and goals", () => {
  it("opens the profile's goal session and hands the orchestrator a run-end hook", async () => {
    const f = fixture();
    const runtime = await createHeadlessRuntime(f.deps);
    runtimes.push(runtime);

    const session = activeGoalSession();
    expect(session).toBeDefined();
    expect(session?.store.root).toBe(path.join(f.profileDir, "goals"));
    expect(session?.config.verify_on_stop).toBe(true);
    expect(f.received[0]?.verification).toBeDefined();
    expect(runtime.goals).toBe(session);
  });

  it("carries the profile's goals block into the session", async () => {
    const f = fixture((config) => {
      config.goals.verify_on_stop = false;
      config.goals.max_continuations = 1;
    });
    runtimes.push(await createHeadlessRuntime(f.deps));
    expect(activeGoalSession()?.config.verify_on_stop).toBe(false);
    expect(activeGoalSession()?.config.max_continuations).toBe(1);
  });

  it("records the seats' terminal calls as verification evidence, with the exit code they report", async () => {
    const f = fixture();
    const runtime = await createHeadlessRuntime(f.deps);
    runtimes.push(runtime);

    const wired = f.received[0]?.tools?.find((adapter) => adapter.name === "terminal");
    expect(wired).toBeDefined();
    await wired!.execute('terminal {"command":"npx tsc --noEmit"}', {});
    await wired!.execute('terminal {"command":"npx vitest run"}', {});
    await wired!.execute('terminal {"command":"ls -la"}', {});

    expect(activeGoalSession()?.evidence.all()).toEqual([
      { command: ["npx", "tsc", "--noEmit"], exitCode: 0, at: expect.any(Number) },
      { command: ["npx", "vitest", "run"], exitCode: 1, at: expect.any(Number) },
      { command: ["ls", "-la"], exitCode: 0, at: expect.any(Number) },
    ]);
  });

  it("closes the goal session on cleanup, so a later tool call belongs to no session", async () => {
    const f = fixture();
    const runtime = await createHeadlessRuntime(f.deps);
    await runtime.cleanup();
    expect(activeGoalSession()).toBeUndefined();
  });
});
