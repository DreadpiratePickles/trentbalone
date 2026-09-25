/**
 * The headless runtime registers its process as a live writer on the profile
 * (packages/trent-core/src/profile/locks.ts), so `trent sessions prune`, `fleet import`,
 * `doctor --fix` and `uninstall` refuse while the REPL, the gateway, cron or `trent run` built on
 * it are up. Its own file rather than `headless.test.ts`, which is already past the 500-line rule.
 */

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ConfigManager } from "@trent/core";
import type { OrcEvent, Orchestrator } from "@trent/core/orchestrator/index.js";
import { liveWriters } from "@trent/core/profile/locks.js";
import { MemoryStore } from "../repl/__tests__/harness.js";
import type { ReplStore } from "../repl/types.js";
import { createHeadlessRuntime, type HeadlessRuntimeDeps } from "./headless.js";

let home = "";
const savedHome = process.env.TRENT_HOME;
let profileN = 0;

beforeAll(() => {
  home = mkdtempSync(path.join(os.tmpdir(), "trent-headless-locks-"));
  process.env.TRENT_HOME = home;
});
afterAll(() => {
  if (savedHome === undefined) delete process.env.TRENT_HOME;
  else process.env.TRENT_HOME = savedHome;
  rmSync(home, { recursive: true, force: true });
});

function deps(openStore?: HeadlessRuntimeDeps["openStore"]): { deps: HeadlessRuntimeDeps; profileDir: string } {
  profileN += 1;
  const configManager = new ConfigManager({ profile: `locks-${profileN}` });
  const config = configManager.loadConfig();
  config.terminal.backend = "local";
  config.egress.enabled = false;
  configManager.saveConfig(config);
  const createOrchestrator = (): Orchestrator =>
    ({
      run: () => Object.assign((async function* (): AsyncGenerator<OrcEvent> {})(), { runId: "run_l", started: Promise.resolve("run_l"), cancel: async () => false }),
      ensureCompany: vi.fn(async () => "cmp_locks"),
      snapshot: async () => undefined,
      approve: async () => true,
      reject: async () => true,
    }) as unknown as Orchestrator;
  return {
    profileDir: configManager.getProfileDir(),
    deps: {
      configManager,
      workspace: home,
      createOrchestrator: createOrchestrator as unknown as HeadlessRuntimeDeps["createOrchestrator"],
      buildAdapters: () => [],
      probeDocker: async () => ({ daemon: false, imagePresent: false }),
      openStore: openStore ?? (async () => ({ store: new MemoryStore() as unknown as ReplStore, durable: true })),
    },
  };
}

describe("createHeadlessRuntime and the profile's writers", () => {
  it("while the graph is up this pid is a writer labelled with its surface; cleanup releases it, once", async () => {
    const fixture = deps();
    const runtime = await createHeadlessRuntime({ ...fixture.deps, surface: "gateway" });
    expect(liveWriters(fixture.profileDir)).toEqual([expect.objectContaining({ pid: process.pid, label: "gateway" })]);
    await runtime.cleanup();
    await runtime.cleanup();
    expect(liveWriters(fixture.profileDir)).toEqual([]);
  });

  it("a runtime that names no surface is still a writer", async () => {
    const fixture = deps();
    const runtime = await createHeadlessRuntime(fixture.deps);
    try {
      expect(liveWriters(fixture.profileDir)).toHaveLength(1);
    } finally {
      await runtime.cleanup();
    }
  });

  it("a graph that fails to come up holds nothing", async () => {
    const fixture = deps(async () => {
      throw new Error("the store would not open");
    });
    await expect(createHeadlessRuntime(fixture.deps)).rejects.toThrow("the store would not open");
    expect(liveWriters(fixture.profileDir)).toEqual([]);
  });
});
