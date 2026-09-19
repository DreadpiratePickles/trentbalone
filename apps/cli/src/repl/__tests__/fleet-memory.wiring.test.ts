/**
 * [C1/C2/C3] What `wireFleetMemory` actually hands `createFleetMemoryHook`.
 *
 * Three seams reached production through this one function and, until this suite, only one of them
 * was connected: the app's company memory was never written to, the embedder was built and never
 * passed (so every real run ranked lexically however `memory.embedder` was configured), and the
 * brain ignored `brain.enabled` / `brain.versioning`. The options object is therefore exported and
 * asserted directly — a hook does not expose which ranker or which brain it was given, and a test
 * that cannot see the wiring is how all three came to be missing.
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AppMemoryWriteModules } from "@trent/core/fleet-memory/index.js";

import { fleetMemoryHookOptions, wireFleetMemory, type FleetMemoryWiringDeps } from "../fleet-memory.js";

let profileDir = "";
beforeEach(() => {
  profileDir = mkdtempSync(path.join(os.tmpdir(), "trent-c1-wiring-"));
});
afterEach(() => {
  rmSync(profileDir, { recursive: true, force: true });
});

interface Episode {
  readonly cycleId: string;
  readonly summary: string;
}

function writeModules(fail?: string): AppMemoryWriteModules & { episodes: Episode[] } {
  const episodes: Episode[] = [];
  return {
    episodes,
    async writeEpisodicMemory(options) {
      if (fail !== undefined) throw new Error(fail);
      episodes.push({ cycleId: options.cycleId, summary: options.summary });
    },
    createSemanticMemory() {
      return { add: () => {}, flush: async () => [] };
    },
    async listDocuments() {
      return [];
    },
    async expireDocument() {},
  };
}

/** A structural `ConfigManager`: the three methods `embedderForProfile` and the brain keys need. */
function manager(config: Record<string, unknown>, secrets: Record<string, string> = {}) {
  return {
    loadConfig: () => config as never,
    loadSecrets: () => secrets as never,
    getProfileDir: () => profileDir,
  };
}

function deps(extra: Partial<FleetMemoryWiringDeps> = {}): FleetMemoryWiringDeps {
  return { profileDir, ...extra };
}

describe("the app memory mirror", () => {
  it("mirrors a seat's completed memory append, tagged with the run and the seat", async () => {
    const modules = writeModules();
    const hook = wireFleetMemory(deps({ appMemoryWrites: modules }));
    hook.runStarted({ runId: "run_1", companyId: "co_1", objective: "raise activation" });
    const seat = hook.wrapSeatModel(async () => {
      await hook.memory.execute('memory {"action":"add","content":"the onboarding email doubled activation"}', {});
      return "done";
    });
    await seat({ companyId: "co_1", subtask: { id: "s1", seat: "growth", objective: "raise activation" } });

    expect(modules.episodes).toHaveLength(1);
    expect(modules.episodes[0]?.cycleId).toBe("run_1:growth");
    expect(modules.episodes[0]?.summary).toContain("doubled activation");
  });

  it("mirrors nothing outside a run, because there is no run or seat to file it under", async () => {
    const modules = writeModules();
    const hook = wireFleetMemory(deps({ appMemoryWrites: modules }));
    await hook.memory.execute('memory {"action":"add","content":"a fact with no run"}', {});
    expect(modules.episodes).toEqual([]);
  });

  it("degrades visibly when the app store would throw, and still tells the seat its write landed", async () => {
    const failures: string[] = [];
    const hook = wireFleetMemory(
      deps({
        appMemoryWrites: writeModules("the URL must start with the protocol `postgresql://`"),
        onAppMemoryFailure: (message) => failures.push(message),
      }),
    );
    hook.runStarted({ runId: "run_1", companyId: "co_1", objective: "raise activation" });
    let record: { status: string } | undefined;
    const seat = hook.wrapSeatModel(async () => {
      record = await hook.memory.execute('memory {"action":"add","content":"a fact worth keeping"}', {});
      return "done";
    });
    await seat({ companyId: "co_1", subtask: { id: "s1", seat: "growth", objective: "raise activation" } });

    expect(record?.status).toBe("completed");
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("postgresql");
  });
});

describe("the embedder reaches the hook", () => {
  it("passes the configured embedder, so a real run ranks hybrid and not lexically", () => {
    const options = fleetMemoryHookOptions(
      deps({
        configManager: manager(
          { provider: "google", memory: { embedder: { provider: "gemini", batch_size: 32 } } },
          { GEMINI_API_KEY: "placeholder-not-a-real-key" },
        ),
      }),
    );
    expect(typeof options.embed).toBe("function");
  });

  it("passes no embedder when none is configured, so recall stays byte-for-byte lexical", () => {
    const options = fleetMemoryHookOptions(deps({ configManager: manager({ memory: { embedder: { provider: "none" } } }) }));
    expect(options.embed).toBeUndefined();
  });
});

describe("the brain keys reach the hook", () => {
  it("turns the brain off entirely when brain.enabled is false", () => {
    const options = fleetMemoryHookOptions(deps({ configManager: manager({ brain: { enabled: false, versioning: "auto" } }) }));
    expect(options.brain).toBe(false);
  });

  it("builds the brain with the configured versioning", () => {
    const options = fleetMemoryHookOptions(deps({ configManager: manager({ brain: { enabled: true, versioning: "off" } }) }));
    expect(options.brain).not.toBe(false);
    expect((options.brain as { status(): { versioning: boolean; versioningReason: string } }).status().versioningReason).toBe("disabled");
  });

  it("leaves the hook to its own default when the config names no brain at all", () => {
    const options = fleetMemoryHookOptions(deps({ configManager: manager({}) }));
    expect(options.brain).not.toBe(false);
  });
});
