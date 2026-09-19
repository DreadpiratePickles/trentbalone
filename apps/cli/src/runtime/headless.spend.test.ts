/**
 * [G3.1] Every surface is on the one daily ledger.
 *
 * The ledger (`governance/spend-ledger.ts`) is installed EXPLICITLY, never implicitly, and the
 * headless runtime is the one graph the REPL, `trent run`, the gateway, cron, the heartbeat and
 * the protocol servers are all built on — so that is where it is installed, and that is where a
 * run's cost is charged. What is under test here is the wiring only: a fake orchestrator emits the
 * `step_end` events a real seat emits, carrying the integer cents the gateway billed, and the
 * assertion is what reached `<profileDir>/spend.ndjson` and under which surface tag.
 *
 * Nothing here opens a socket, a sandbox or a model.
 */

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ConfigManager } from "@trent/core";
import { currentSpendLedger, openSpendLedger, spendLedgerPath } from "@trent/core/governance/index.js";
import type { OrcEvent, Orchestrator, OrchestratorDepsWithImprove } from "@trent/core/orchestrator/index.js";
import { closeRunScope, openRunScope } from "@trent/core/orchestrator/run-hooks.js";
import type { TrentToolAdapter } from "@trent/core/tools/index.js";
import { MemoryStore } from "../repl/__tests__/harness.js";
import type { ReplStore } from "../repl/types.js";
import type { EgressHandle } from "../repl/tools.js";
import { createHeadlessRuntime, type HeadlessRuntime, type HeadlessRuntimeDeps } from "./headless.js";

const REPO_ROOT = path.resolve(__dirname, "../../../..");
const COMPANY_ID = "cmp_spend";

let home = "";
const savedHome = process.env.TRENT_HOME;
let profileN = 0;

beforeAll(() => {
  home = mkdtempSync(path.join(os.tmpdir(), "trent-spend-"));
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

/** One billed step, as the orchestrator shapes it: the seat, the model, the tokens and the cents. */
function billedStep(runId: string, cents: number, seat: string, model: string): OrcEvent {
  return {
    kind: "step_end",
    runId,
    at: "2026-09-19T12:00:00.000Z",
    step: { id: "stp_1", agentRole: seat, model, tokens: 640, costCents: cents },
  };
}

interface Fakes {
  deps: HeadlessRuntimeDeps;
  configManager: ConfigManager;
  profileDir: string;
  provider: string;
  runOptions: Parameters<Orchestrator["run"]>[0][];
}

/**
 * The runtime with every collaborator that would touch a daemon, a proxy or a model replaced.
 * `events` is what the fake orchestrator emits for each run; it pushes them through the trace sink
 * exactly as `orchestrator/index.ts` `deliver` does, and opens and closes the run scope around
 * them as `launchOrchestration` and the run's `finally` do.
 */
function fakes(events: (runId: string) => OrcEvent[], extra: Partial<HeadlessRuntimeDeps> = {}): Fakes {
  profileN += 1;
  const configManager = new ConfigManager({ profile: `spend-${profileN}` });
  const config = configManager.loadConfig();
  config.terminal.backend = "local";
  configManager.saveConfig(config);

  const runOptions: Parameters<Orchestrator["run"]>[0][] = [];
  let runN = 0;

  const createOrchestrator = (deps: OrchestratorDepsWithImprove = {}): Orchestrator => ({
    run: (options) => {
      runOptions.push(options);
      runN += 1;
      const runId = `run_${runN}`;
      const iterable = (async function* () {
        openRunScope([], runId, options);
        try {
          for (const event of events(runId)) {
            deps.traceSink?.(event);
            yield event;
          }
        } finally {
          closeRunScope([], runId);
        }
      })();
      return Object.assign(iterable, {
        runId,
        started: Promise.resolve(runId),
        result: async () => {
          throw new Error("this test iterates the stream instead");
        },
        cancel: async () => false,
      });
    },
    ensureCompany: async () => COMPANY_ID,
    snapshot: async () => undefined,
    approve: async () => true,
    reject: async () => true,
  });

  const adapter = {
    name: "fake_tool",
    scopes: ["read"],
    instructions: "",
    routingText: "",
    execute: async () => ({ ok: true, output: "" }),
    cleanup: vi.fn(async () => undefined),
  } as unknown as TrentToolAdapter;

  const handle: EgressHandle = {
    port: 1,
    url: "http://127.0.0.1:1",
    token: "t",
    caCertPath: "/dev/null",
    isListening: () => true,
    stop: async () => undefined,
  };

  const deps: HeadlessRuntimeDeps = {
    configManager,
    workspace: REPO_ROOT,
    createOrchestrator,
    buildAdapters: () => [adapter],
    startEgress: async () => handle,
    probeDocker: async () => ({ daemon: false, imagePresent: false }),
    openStore: async () => ({ store: new MemoryStore() as unknown as ReplStore, durable: true }),
    ...extra,
  };
  return { deps, configManager, profileDir: configManager.getProfileDir(), provider: config.provider, runOptions };
}

/** Every row this profile's ledger holds, in the order it was written. */
function rowsOf(profileDir: string): ReturnType<ReturnType<typeof openSpendLedger>["rows"]> {
  return openSpendLedger({ profileDir }).rows();
}

async function drain(stream: AsyncIterable<OrcEvent>): Promise<void> {
  for await (const _ of stream) void _;
}

describe("the headless runtime on the one daily spend ledger", () => {
  /** Every surface that builds this runtime; each names itself, and none of them is `unknown`. */
  const SURFACES = ["repl", "run", "gateway", "cron", "heartbeat", "a2a", "acp"] as const;

  for (const surface of SURFACES) {
    it(`charges a ${surface} run to the profile ledger under its own surface`, async () => {
      const f = fakes((runId) => [billedStep(runId, 17, "engineer", "claude-sonnet-4")], { surface });
      const runtime = await createHeadlessRuntime(f.deps);
      runtimes.push(runtime);

      await drain(runtime.run("ship it"));

      const rows = rowsOf(f.profileDir);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        surface,
        run_id: "run_1",
        seat: "engineer",
        model: "claude-sonnet-4",
        provider: f.provider,
        cents: 17,
        tokens: 640,
      });
      // The run options the orchestrator was handed carry the tag, which is where the scope reads it.
      expect(f.runOptions[0]).toMatchObject({ surface });
    });
  }

  it("lets a run name a surface the runtime was not built for, because cron and the heartbeat ride the gateway's runtime", async () => {
    // `openHeartbeat` and the cron runner are handed the gateway's already-built runtime
    // (`servers.ts`), so the per-run tag — not the runtime's default — is what makes their spend
    // legible in `trent budget status`.
    const f = fakes((runId) => [billedStep(runId, 9, "analyst", "claude-haiku-4")], { surface: "gateway" });
    const runtime = await createHeadlessRuntime(f.deps);
    runtimes.push(runtime);

    await drain(runtime.run("the nightly digest", { trigger: "scheduled", surface: "cron" }));
    await drain(runtime.run("the sweep", { trigger: "heartbeat", surface: "heartbeat" }));
    await drain(runtime.run("a card from the owner"));

    expect(rowsOf(f.profileDir).map((row) => row.surface)).toEqual(["cron", "heartbeat", "gateway"]);
  });

  it("groups a run's charges by seat, model and provider, and writes them once the run ends", async () => {
    const f = fakes(
      (runId) => [
        billedStep(runId, 12, "engineer", "claude-sonnet-4"),
        billedStep(runId, 3, "engineer", "claude-sonnet-4"),
        { kind: "consolidate_end", runId, at: "2026-09-19T12:01:00.000Z", step: { model: "claude-opus-4", tokens: 100, costCents: 40 } },
      ],
      { surface: "run" },
    );
    const runtime = await createHeadlessRuntime(f.deps);
    runtimes.push(runtime);

    const stream = runtime.run("do the thing");
    const seen: OrcEvent["kind"][] = [];
    for await (const event of stream) {
      seen.push(event.kind);
      // Nothing is on disk until the run ends: the ledger is a record of runs, not of frames.
      expect(rowsOf(f.profileDir)).toEqual([]);
    }
    expect(seen).toEqual(["step_end", "step_end", "consolidate_end"]);

    const rows = rowsOf(f.profileDir);
    expect(rows.map((row) => [row.seat, row.model, row.cents, row.tokens])).toEqual([
      ["engineer", "claude-sonnet-4", 15, 1280],
      [undefined, "claude-opus-4", 40, 100],
    ]);
    expect(openSpendLedger({ profileDir: f.profileDir }).runTotalCents("run_1")).toBe(55);
  });

  it("ignores a step that carries no integer cost rather than charging a guess", async () => {
    const f = fakes(
      (runId) => [
        { kind: "step_end", runId, at: "2026-09-19T12:00:00.000Z", step: { agentRole: "engineer", model: "claude-sonnet-4" } },
        { kind: "step_end", runId, at: "2026-09-19T12:00:01.000Z", step: { agentRole: "engineer", costCents: 0.5 } },
      ],
      { surface: "run" },
    );
    const runtime = await createHeadlessRuntime(f.deps);
    runtimes.push(runtime);

    await drain(runtime.run("nothing was billed"));
    expect(rowsOf(f.profileDir)).toEqual([]);
  });

  it("installs the profile's ledger for the life of the runtime and uninstalls it on cleanup", async () => {
    const f = fakes(() => []);
    expect(currentSpendLedger()).toBeUndefined();

    const runtime = await createHeadlessRuntime(f.deps);
    expect(currentSpendLedger()?.path).toBe(spendLedgerPath(f.profileDir));

    await runtime.cleanup();
    // A process that installs none writes none: the heartbeat sweep's own charge and anything else
    // reading `currentSpendLedger()` must not find a closed session's profile.
    expect(currentSpendLedger()).toBeUndefined();
    // Idempotent, because every exit path calls it.
    await runtime.cleanup();
    expect(currentSpendLedger()).toBeUndefined();
  });
});
