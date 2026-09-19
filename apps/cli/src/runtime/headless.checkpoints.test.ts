/**
 * E1 — the headless runtime opens the checkpoint session.
 *
 * It is opened in the graph every surface is built on, so `trent run`, the gateway, cron, the
 * heartbeat and the REPL all ledger their seats' file writes with no wiring of their own:
 * `file_ops` looks the session up on the process, not on a context it is handed. These tests
 * drive the REAL `file_ops` adapter the runtime built — the same object the orchestrator was
 * given — because a ledger that only works when a test calls the store proves nothing about the
 * path a seat actually takes.
 *
 * Its own file rather than `headless.test.ts`, which is already past the 500-line rule.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ConfigManager } from "@trent/core";
import { activeCheckpointSession } from "@trent/core/checkpoints/index.js";
import { createFileOpsAdapter } from "@trent/core/tools/file_ops/index.js";
import type { OrcEvent, Orchestrator } from "@trent/core/orchestrator/index.js";
import { MemoryStore } from "../repl/__tests__/harness.js";
import type { ReplStore } from "../repl/types.js";
import { createHeadlessRuntime, type HeadlessRuntime, type HeadlessRuntimeDeps } from "./headless.js";

const COMPANY_ID = "cmp_ckpt";

let home = "";
const savedHome = process.env.TRENT_HOME;
let profileN = 0;

beforeAll(() => {
  home = mkdtempSync(path.join(os.tmpdir(), "trent-headless-ckpt-"));
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

/** Two events, no model: what is under test is the wiring, never a reply. */
function events(): AsyncIterable<OrcEvent> {
  return (async function* () {
    yield { kind: "run_start", runId: "run_c", at: "2026-09-18T00:00:00.000Z" } as OrcEvent;
    yield { kind: "run_done", runId: "run_c", at: "2026-09-18T00:00:00.000Z" } as OrcEvent;
  })();
}

/** A runtime whose only toolset is the real `file_ops`, over a throwaway workspace. */
function deps(enabled?: boolean): { deps: HeadlessRuntimeDeps; workspace: string; profileDir: string } {
  profileN += 1;
  const configManager = new ConfigManager({ profile: `ckpt-${profileN}` });
  const config = configManager.loadConfig();
  config.terminal.backend = "local";
  if (enabled !== undefined) config.checkpoints.enabled = enabled;
  configManager.saveConfig(config);

  const workspace = mkdtempSync(path.join(home, "ws-"));
  writeFileSync(path.join(workspace, "a.txt"), "original\n");
  const createOrchestrator = (): Orchestrator =>
    ({
      run: () => Object.assign(events(), { runId: "run_c", started: Promise.resolve("run_c"), cancel: async () => false }),
      ensureCompany: vi.fn(async () => COMPANY_ID),
      snapshot: async () => undefined,
      approve: async () => true,
      reject: async () => true,
    }) as unknown as Orchestrator;

  return {
    workspace,
    profileDir: configManager.getProfileDir(),
    deps: {
      configManager,
      workspace,
      createOrchestrator: createOrchestrator as unknown as HeadlessRuntimeDeps["createOrchestrator"],
      buildAdapters: (_config, build) => [
        createFileOpsAdapter({ workspace: build.workspace, profileDir: build.profileDir, backend: "local", autoApproveWrites: true }),
      ],
      probeDocker: async () => ({ daemon: false, imagePresent: false }),
      openStore: async () => ({ store: new MemoryStore() as unknown as ReplStore, durable: true }),
    },
  };
}

/** One write through the adapter the runtime handed the orchestrator. */
async function seatWrite(runtime: HeadlessRuntime, file: string, content: string): Promise<void> {
  const fileOps = runtime.tools.adapters.find((adapter) => adapter.name === "file_ops");
  if (fileOps === undefined) throw new Error("the runtime built no file_ops adapter");
  const result = await fileOps.execute(`write_file ${JSON.stringify({ path: file, content })}`, {});
  expect(result.status).toBe("completed");
}

describe("createHeadlessRuntime and the checkpoint ledger", () => {
  it("ledgers a seat's write against the run's turn, and rolls it back byte-exact", async () => {
    const fixture = deps();
    const runtime = await createHeadlessRuntime(fixture.deps);
    runtimes.push(runtime);
    const checkpoints = runtime.checkpoints;
    expect(checkpoints).toBeDefined();
    if (checkpoints === undefined) return;

    for await (const _ of runtime.run("edit a.txt")) void _;
    await seatWrite(runtime, "a.txt", "written by a seat\n");
    for await (const _ of runtime.run("add b.txt")) void _;
    await seatWrite(runtime, "b.txt", "a new file\n");

    expect(checkpoints.listCheckpoints().map((turn) => [turn.turn, [...turn.files]])).toEqual([
      [1, ["a.txt"]],
      [2, ["b.txt"]],
    ]);

    expect(checkpoints.rollback({ to: 1 }).ok).toBe(true);
    expect(existsSync(path.join(fixture.workspace, "b.txt"))).toBe(false);
    expect(readFileSync(path.join(fixture.workspace, "a.txt"), "utf8")).toBe("written by a seat\n");

    expect(checkpoints.rollback({ to: 0 }).ok).toBe(true);
    expect(readFileSync(path.join(fixture.workspace, "a.txt"), "utf8")).toBe("original\n");
  });

  it("checkpoints.enabled false ledgers nothing and creates no directory", async () => {
    const fixture = deps(false);
    const runtime = await createHeadlessRuntime(fixture.deps);
    runtimes.push(runtime);

    expect(runtime.checkpoints).toBeUndefined();
    expect(activeCheckpointSession()).toBeUndefined();
    for await (const _ of runtime.run("edit a.txt")) void _;
    await seatWrite(runtime, "a.txt", "written with checkpoints off\n");

    expect(readFileSync(path.join(fixture.workspace, "a.txt"), "utf8")).toBe("written with checkpoints off\n");
    expect(existsSync(path.join(fixture.profileDir, "checkpoints"))).toBe(false);
  });

  it("cleanup closes the session, so a later write is ledgered into no finished run", async () => {
    const fixture = deps();
    const runtime = await createHeadlessRuntime(fixture.deps);
    const checkpoints = runtime.checkpoints;
    expect(activeCheckpointSession()).toBe(checkpoints);

    await seatWrite(runtime, "a.txt", "first\n");
    await runtime.cleanup();
    expect(activeCheckpointSession()).toBeUndefined();
    expect(checkpoints?.listCheckpoints()).toHaveLength(1);
    await seatWrite(runtime, "a.txt", "after cleanup\n");
    expect(checkpoints?.listCheckpoints()).toHaveLength(1);
  });
});
