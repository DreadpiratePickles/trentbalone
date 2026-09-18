/**
 * Task A0.5 — failure goldens in a real CLI run.
 *
 * `wireImproveLoop` is the single place every surface builds the improve deps it hands to
 * `createOrchestrator`. It passed no golden directory, so `improve/hook.ts` built no capture
 * (`goldenDir === undefined` disables it) and a failed run left no regression fixture behind,
 * anywhere, ever. Both runs below are REAL offline orchestrations through the wrapper: the
 * events, the run ids and the fixture on disk all come from the orchestrator, not from a
 * hand-built list.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { bootOffline, collect, imitateCompiledBinary, newCompany, restoreEnv } from "@trent/core/improve/offline-harness.js";
import type { OrcEvent, OrchestrationRunSnapshot } from "@trent/core/orchestrator/types.js";
import { wireImproveLoop } from "../improve-loop.js";

const SECRET = "sk-live-abcdefghijklmnopqrstuvwxyz0123456789";
const OBJECTIVE = `Rotate the billing webhook and re-verify with key ${SECRET} then email ops@example.com`;
const CONFIG = { fleet: { installed_agents: [] as string[] } };

/** A throwaway profile directory, exactly as the CLI would hand one to the wiring. */
function newProfileDir(): string {
  return mkdtempSync(path.join(tmpdir(), "trent-profile-"));
}

describe("wireImproveLoop — a failed run leaves a golden under the profile", () => {
  let goldensDir = "";
  let events: OrcEvent[] = [];
  let runId = "";

  beforeAll(async () => {
    imitateCompiledBinary();
    const { applyStandaloneEnv, IN_MEMORY_DATABASE } = await import("@trent/core/runtime/env.js");
    applyStandaloneEnv(IN_MEMORY_DATABASE);
    const profileDir = newProfileDir();
    goldensDir = path.join(profileDir, "goldens");
    const deps = wireImproveLoop({ store: {}, config: CONFIG, profileDir });
    const { createOrchestrator } = await import("@trent/core/orchestrator/index.js");
    const orchestrator = createOrchestrator({
      model: { provider: "google", model: "gemini-3.5-flash-lite" },
      createChatCompletion: async () => {
        throw new Error(`404 status code (no body) for ${SECRET}`);
      },
      improve: deps.improve,
    });
    const companyId = await newCompany("ReplImproveGoldens");
    const collected = await collect(orchestrator.run({ companyId, objective: OBJECTIVE }));
    events = collected.events;
    runId = collected.snapshot.id;
  }, 120_000);

  afterAll(restoreEnv);

  it("the run really failed", () => {
    expect(events.map((e) => e.kind)).toContain("run_failed");
  });

  it("created <profile>/goldens on demand, reachable only by the profile's owner", () => {
    expect(existsSync(goldensDir)).toBe(true);
    expect(statSync(goldensDir).mode & 0o777).toBe(0o700);
  });

  it("captured one quarantined golden for the failed run, with the key and the address redacted", () => {
    const files = readdirSync(goldensDir).filter((file) => file.endsWith(".json"));
    expect(files).toEqual([`golden-${runId}.json`]);
    const raw = readFileSync(path.join(goldensDir, files[0]!), "utf8");
    expect(raw).not.toContain(SECRET);
    expect(raw).not.toContain("ops@example.com");
    const golden = JSON.parse(raw) as { status: string; runId: string; objective: string; reason: string };
    expect(golden.status).toBe("quarantined");
    expect(golden.runId).toBe(runId);
    expect(golden.objective).toContain("[KEY_REDACTED]");
    expect(golden.reason).toContain("run_failed");
  });
});

describe("wireImproveLoop — a run whose steps succeed captures nothing", () => {
  let goldensDir = "";
  let events: OrcEvent[] = [];
  let snapshot: OrchestrationRunSnapshot;

  beforeAll(async () => {
    imitateCompiledBinary();
    const harness = await bootOffline("ReplImproveNoGoldens");
    const profileDir = newProfileDir();
    goldensDir = path.join(profileDir, "goldens");
    const deps = wireImproveLoop({ store: {}, config: CONFIG, profileDir });
    const { createOrchestrator } = await import("@trent/core/orchestrator/index.js");
    const orchestrator = createOrchestrator({
      createCompletion: harness.createCompletion,
      executeSeatModelFn: harness.executeSeatModelFn,
      improve: deps.improve,
    });
    const collected = await collect(orchestrator.run({ companyId: harness.companyId, objective: harness.objective }));
    events = collected.events;
    snapshot = collected.snapshot;
  }, 120_000);

  afterAll(restoreEnv);

  it("the run finished real steps and never failed", () => {
    expect(snapshot.steps.length).toBeGreaterThan(1);
    expect(events.some((event) => event.kind === "step_end")).toBe(true);
    expect(events.some((event) => event.kind === "run_failed")).toBe(false);
  });

  it("wrote no fixture into the goldens directory", () => {
    expect(existsSync(goldensDir)).toBe(true);
    expect(readdirSync(goldensDir)).toEqual([]);
  });
});

/**
 * The headless runtime calls `wireImproveLoop({ store, config })` and passes no directory, so the
 * wiring has to find the profile itself or capture stays off for the one caller that matters.
 */
describe("wireImproveLoop — the golden directory is derived when no caller passes one", () => {
  const savedHome = process.env.TRENT_HOME;
  const savedProfile = process.env.TRENT_PROFILE;
  let home = "";

  beforeAll(() => {
    home = mkdtempSync(path.join(tmpdir(), "trent-home-"));
    process.env.TRENT_HOME = home;
  });

  afterAll(() => {
    if (savedHome === undefined) delete process.env.TRENT_HOME;
    else process.env.TRENT_HOME = savedHome;
    if (savedProfile === undefined) delete process.env.TRENT_PROFILE;
    else process.env.TRENT_PROFILE = savedProfile;
  });

  it("uses the base directory for the default profile", () => {
    delete process.env.TRENT_PROFILE;
    wireImproveLoop({ store: {}, config: CONFIG });
    const dir = path.join(home, "goldens");
    expect(existsSync(dir)).toBe(true);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it("follows the profile the loaded config names, then $TRENT_PROFILE over it", () => {
    delete process.env.TRENT_PROFILE;
    wireImproveLoop({ store: {}, config: { ...CONFIG, profile: "from-config" } });
    expect(existsSync(path.join(home, "profiles", "from-config", "goldens"))).toBe(true);

    process.env.TRENT_PROFILE = "from-env";
    wireImproveLoop({ store: {}, config: { ...CONFIG, profile: "from-config" } });
    expect(existsSync(path.join(home, "profiles", "from-env", "goldens"))).toBe(true);
  });
});
