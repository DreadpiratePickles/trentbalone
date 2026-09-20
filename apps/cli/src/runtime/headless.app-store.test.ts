/**
 * A headless run never constructs the app's Postgres client unless the app has a Postgres database.
 *
 * `apps/web/lib/store.ts:11` selects the Prisma store whenever `DATABASE_URL` is truthy and
 * `apps/web/lib/db.ts:8` builds that client for a postgresql datasource, starting a query-engine
 * load that nothing awaits. The standalone runtime used to hand the CORE store's SQLite URL
 * (`file:<profile>/trent.db`) to the orchestrator, which exported it as the app's `DATABASE_URL`:
 * from source under Bun every app-store call then failed on a URL the app cannot take, and from
 * the compiled binary — where the core store cannot open and the variable stays unset — the client
 * was still constructed by the first `import("@/lib/store")`, so on any machine without the engine
 * the load rejected unhandled and Bun killed `trent run` mid-stream (binary.yml's Linux RUN job).
 *
 * The module registry is the observation point, as in `doctor/app-store-isolation.test.ts`: a
 * mocked specifier records every evaluation of it. The orchestrator is a fake (its own `loadLibs`
 * imports `@/lib/store` on every run, and must), so what is measured here is the wrapper's side,
 * as two separate invariants:
 *
 *   1. the STATIC graph of the runtime module evaluates no store-bound app module — a wrapper
 *      module that imports one at the top level evaluates the app's store at CLI start-up, before
 *      any decision about the app's database can be made, and re-opens the Linux death for every
 *      command (the rule `orchestrator/libs.ts` follows: app imports are lazy, inside functions);
 *   2. the RUNTIME paths — the env handling, the guard on the app's singleton seam, and the fleet
 *      memory app tiers a seat call reads and writes through the real CLI wiring — touch none of
 *      them unless the app has a postgres database.
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OrcEvent, Orchestrator, OrchestratorDepsWithImprove } from "@trent/core/orchestrator/index.js";
import type { TrentToolAdapter } from "@trent/core/tools/index.js";
import type { ReplStore } from "../repl/types.js";
import type { EgressHandle } from "../repl/tools.js";
import type { HeadlessRuntime, HeadlessRuntimeDeps } from "./headless.js";

// Every value import is dynamic and happens AFTER the mocks below are registered: a top-level
// import of `@trent/core` would evaluate the wrapper's whole static graph first, and whatever that
// graph reaches in `apps/web` would be the real module, outside the registry's observation.
const isAppDatabaseGuard = async (value: unknown): Promise<boolean> =>
  (await import("@trent/core/fleet-memory/app-store.js")).isAppDatabaseGuard(value);

const REPO_ROOT = path.resolve(__dirname, "../../../..");
const COMPANY_ID = "cmp_app_store";

/** The app modules whose evaluation constructs, or is only ever reached through, the app's store. */
const STORE_BOUND = ["@/lib/store", "@/lib/db", "@prisma/client", "@/lib/memory-tiers"] as const;
/** The run-derived recall's modules: mocked so they neither pull the store in nor touch the app's caches. */
const RUN_DERIVED = ["@/lib/orchestrator", "@/lib/self-improvement/company-playbook-log"] as const;

let loaded: string[] = [];
const listDocuments = vi.fn(async (_companyId: string): Promise<unknown[]> => []);
const writeEpisodicMemory = vi.fn(async (_input: unknown): Promise<void> => undefined);

const EXPORTS: Record<string, () => Record<string, unknown>> = {
  "@/lib/store": () => ({ store: { listDocuments } }),
  "@/lib/db": () => ({ db: {} }),
  "@prisma/client": () => ({ PrismaClient: class {} }),
  "@/lib/memory-tiers": () => ({ writeEpisodicMemory, SemanticMemory: class {} }),
  "@/lib/orchestrator": () => ({ listOrchestrationRunSnapshots: async () => [] }),
  "@/lib/self-improvement/company-playbook-log": () => ({ getCompanyPlaybookLog: () => ({ list: async () => [] }) }),
};

let home = "";
const savedHome = process.env.TRENT_HOME;
let profileN = 0;
const runtimes: HeadlessRuntime[] = [];

beforeAll(() => {
  home = mkdtempSync(path.join(os.tmpdir(), "trent-headless-app-store-"));
  process.env.TRENT_HOME = home;
});
afterAll(() => {
  if (savedHome === undefined) delete process.env.TRENT_HOME;
  else process.env.TRENT_HOME = savedHome;
  rmSync(home, { recursive: true, force: true });
});

beforeEach(() => {
  vi.resetModules();
  loaded = [];
  listDocuments.mockClear();
  writeEpisodicMemory.mockClear();
  for (const specifier of [...STORE_BOUND, ...RUN_DERIVED]) {
    vi.doMock(specifier, () => {
      loaded.push(specifier);
      return EXPORTS[specifier]!();
    });
  }
  vi.stubEnv("TRENT_QUEUE_FALLBACK", "disabled");
  vi.stubEnv("REDIS_URL", "");
});

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.cleanup();
  for (const specifier of [...STORE_BOUND, ...RUN_DERIVED]) vi.doUnmock(specifier);
  vi.unstubAllEnvs();
  const g = globalThis as Record<string, unknown>;
  if (await isAppDatabaseGuard(g.__prisma)) delete g.__prisma;
});

function ev(kind: OrcEvent["kind"], extra: Partial<OrcEvent> = {}): OrcEvent {
  return { kind, runId: "run_s", at: "2026-09-20T00:00:00.000Z", ...extra } as OrcEvent;
}

interface Fakes {
  deps: HeadlessRuntimeDeps;
  received: OrchestratorDepsWithImprove[];
}

async function fakes(): Promise<Fakes> {
  const { ConfigManager } = await import("@trent/core");
  const { MemoryStore } = await import("../repl/__tests__/harness.js");
  profileN += 1;
  const configManager = new ConfigManager({ profile: `app-store-${profileN}` });
  const config = configManager.loadConfig();
  config.terminal.backend = "local";
  configManager.saveConfig(config);

  const received: OrchestratorDepsWithImprove[] = [];
  const createOrchestrator = (deps: OrchestratorDepsWithImprove = {}): Orchestrator => {
    received.push(deps);
    return {
      run: () => {
        const iterable = (async function* () {
          yield ev("run_start", { run: { objective: "hello" } });
          yield ev("run_done", { run: { status: "completed" } });
        })();
        return Object.assign(iterable, {
          runId: "run_s",
          started: Promise.resolve("run_s"),
          result: async () => {
            throw new Error("not used by this test");
          },
          cancel: async () => false,
        });
      },
      ensureCompany: async () => COMPANY_ID,
      snapshot: async () => undefined,
      approve: async () => true,
      reject: async () => true,
    };
  };
  const adapter = {
    name: "fake_tool",
    scopes: ["read"],
    instructions: "",
    routingText: "",
    execute: async () => ({ ok: true, output: "" }),
    cleanup: async () => undefined,
  } as unknown as TrentToolAdapter;
  const handle: EgressHandle = {
    port: 1,
    url: "http://127.0.0.1:1",
    token: "t",
    caCertPath: "/dev/null",
    isListening: () => true,
    stop: async () => undefined,
  };
  const store = new MemoryStore();
  const deps: HeadlessRuntimeDeps = {
    configManager,
    workspace: REPO_ROOT,
    createOrchestrator,
    buildAdapters: () => [adapter],
    startEgress: async () => handle,
    probeDocker: async () => ({ daemon: false, imagePresent: false }),
    // The durable core store, as under Bun: what must NOT follow from it is the app's DATABASE_URL.
    openStore: async () => ({ store: store as unknown as ReplStore, durable: true }),
  };
  return { deps, received };
}

/**
 * One seat call through the real wiring: the prelude reads the app tiers (`listAppMemory`) on the
 * way in, and the seat's `memory` append is mirrored into the app's episodic tier when the step
 * settles. Both are the paths that used to reach the app's store singleton.
 */
async function seatCallWithAppend(runtime: HeadlessRuntime): Promise<void> {
  const fleet = runtime.fleetMemory;
  fleet.runStarted({ runId: "run_s", companyId: COMPANY_ID, objective: "raise activation" });
  const seat = fleet.wrapSeatModel(async () => {
    await fleet.memory.execute('memory {"action":"add","content":"the onboarding email doubled activation"}', {});
    return "done";
  });
  await seat({ companyId: COMPANY_ID, subtask: { id: "s1", seat: "growth", objective: "raise activation" } });
  fleet.runFinished("run_s");
  // The mirror writes after the step settles, off the seat call's own promise.
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** Invariant 2's window: the static graph is evaluated first and its loads discarded. */
async function open(): Promise<{ runtime: HeadlessRuntime; received: OrchestratorDepsWithImprove[] }> {
  const { createHeadlessRuntime } = await import("./headless.js");
  const f = await fakes();
  loaded = [];
  const runtime = await createHeadlessRuntime(f.deps);
  runtimes.push(runtime);
  return { runtime, received: f.received };
}

const storeBound = (): string[] => loaded.filter((specifier) => (STORE_BOUND as readonly string[]).includes(specifier));

describe("the runtime module's static graph", () => {
  it("evaluates none of the store-bound app modules, so the app's database can still be decided at run time", async () => {
    vi.stubEnv("DATABASE_URL", undefined);
    await import("./headless.js");
    expect(
      storeBound(),
      "a wrapper module in the CLI's static graph imports an app module that reaches the app's store at the top level; " +
        "make that import lazy (inside the function that needs it), as orchestrator/libs.ts does",
    ).toEqual([]);
  });
});

describe("a headless run on the standalone durable profile (DATABASE_URL is a file: URL)", () => {
  it("never evaluates the app's store, its db module, @prisma/client or the tier writers, and guards the app's singleton seam", async () => {
    vi.stubEnv("DATABASE_URL", "file:/tmp/some-profile/trent.db");
    const { runtime, received } = await open();
    for await (const _ of runtime.run("hello")) void _;
    await seatCallWithAppend(runtime);

    expect(storeBound()).toEqual([]);
    expect(listDocuments).not.toHaveBeenCalled();
    expect(writeEpisodicMemory).not.toHaveBeenCalled();
    // The core store's URL is not the app's: the orchestrator is told nothing, so
    // `applyStandaloneEnv` clears the value and the app stays on its in-process store.
    expect(received[0]?.databaseUrl).toBeUndefined();
    expect(await isAppDatabaseGuard((globalThis as Record<string, unknown>).__prisma)).toBe(true);
  });
});

describe("a headless run with no DATABASE_URL at all", () => {
  it("skips the app tiers the same way, and the seat's own block write still completes", async () => {
    vi.stubEnv("DATABASE_URL", undefined);
    const { runtime, received } = await open();
    let status: string | undefined;
    const fleet = runtime.fleetMemory;
    fleet.runStarted({ runId: "run_s", companyId: COMPANY_ID, objective: "raise activation" });
    const seat = fleet.wrapSeatModel(async () => {
      status = (await fleet.memory.execute('memory {"action":"add","content":"a fact worth keeping"}', {})).status;
      return "done";
    });
    await seat({ companyId: COMPANY_ID, subtask: { id: "s1", seat: "growth", objective: "raise activation" } });
    fleet.runFinished("run_s");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(status).toBe("completed");
    expect(storeBound()).toEqual([]);
    expect(listDocuments).not.toHaveBeenCalled();
    expect(writeEpisodicMemory).not.toHaveBeenCalled();
    expect(received[0]?.databaseUrl).toBeUndefined();
    expect(await isAppDatabaseGuard((globalThis as Record<string, unknown>).__prisma)).toBe(true);
  });
});

describe("a headless run with a postgres DATABASE_URL", () => {
  it("hands the app's own URL to the orchestrator, installs no guard, and reads and mirrors through the app's store", async () => {
    vi.stubEnv("DATABASE_URL", "postgresql://localhost/trent");
    const { runtime, received } = await open();
    await seatCallWithAppend(runtime);

    expect(received[0]?.databaseUrl).toBe("postgresql://localhost/trent");
    expect(await isAppDatabaseGuard((globalThis as Record<string, unknown>).__prisma)).toBe(false);
    // The read side imported the app's store (the call proves it, whether or not the registry
    // already held the module) and the write side imported the app's tier writers.
    expect(listDocuments).toHaveBeenCalledWith(COMPANY_ID);
    expect(loaded).toContain("@/lib/memory-tiers");
    expect(writeEpisodicMemory).toHaveBeenCalledTimes(1);
    expect(writeEpisodicMemory.mock.calls[0]?.[0]).toMatchObject({ companyId: COMPANY_ID, cycleId: "run_s:growth" });
  });
});
