/**
 * The doctor on an empty profile never loads the wrapped app's store or its Prisma client.
 *
 * Why this is a hard line and not a preference: every module that exports the app's store,
 * `@/lib/mem-store` included, evaluates `apps/web/lib/db.ts:8`, `new PrismaClient()`, and Prisma's
 * LibraryEngine constructor starts loading the postgres query-engine library as a promise nothing
 * awaits. With no `DATABASE_URL` the app selects its in-process store (`apps/web/lib/store.ts:11`),
 * so no query ever reaches that client and nothing ever handles the promise. On any machine but the
 * one that built the binary the engine library is not found, the promise rejects, and Bun kills
 * `trent doctor --json` with exit 1 before the report is written. binary.yml's RUN job on
 * ubuntu-latest saw exactly that from f403127 on, once `checkMedia` ran after `checkAppMemory` and
 * its `docker inspect` kept the process alive long enough for the rejection to land.
 *
 * Vitest's module registry is the observation point: a mocked specifier records every evaluation
 * of it, from anywhere in the worker's graph, static or dynamic. The mocks are registered per test
 * with `vi.doMock` (a hoisted `vi.mock` factory runs once per file and survives `resetModules`),
 * so each test's import list starts empty.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConfigManager } from "../config/ConfigManager.js";
import { DEFAULT_CHECKS, DoctorRunner } from "./DoctorRunner.js";
import { checkAppMemory } from "./checks/app-memory.js";
import type { DoctorContext } from "./types.js";

const GUARDED = ["@/lib/store", "@/lib/db", "@prisma/client"] as const;

/** Every guarded specifier evaluated in the current test, in order. */
let loaded: string[] = [];
const listDocuments = vi.fn(async (_companyId: string): Promise<unknown[]> => []);

const EXPORTS: Record<(typeof GUARDED)[number], () => Record<string, unknown>> = {
  "@/lib/store": () => ({ store: { listDocuments } }),
  "@/lib/db": () => ({ db: {} }),
  "@prisma/client": () => ({ PrismaClient: class {} }),
};

let tempDir: string;
let configManager: ConfigManager;

const context = (): DoctorContext => ({
  baseDir: tempDir,
  profile: "default",
  configManager,
  probeTimeoutMs: 150,
});

beforeEach(() => {
  vi.resetModules();
  loaded = [];
  listDocuments.mockClear();
  for (const specifier of GUARDED) {
    vi.doMock(specifier, () => {
      loaded.push(specifier);
      return EXPORTS[specifier]();
    });
  }
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-doctor-app-store-"));
  configManager = new ConfigManager({ baseDir: tempDir });
  configManager.ensureDirs();
  vi.stubEnv("TRENT_QUEUE_FALLBACK", "disabled");
  vi.stubEnv("REDIS_URL", "");
});

afterEach(() => {
  for (const specifier of GUARDED) vi.doUnmock(specifier);
  vi.unstubAllEnvs();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("check_app_memory on an empty profile", () => {
  it("reports the in-process store without loading the app's store or its Prisma client", async () => {
    vi.stubEnv("DATABASE_URL", undefined);
    const result = await checkAppMemory.run(context());
    expect(result.status).toBe("warn");
    expect(result.message).toContain("ephemeral");
    expect(result.details).toMatchObject({ reachable: true, store: "memory", durable: false });
    expect(loaded).toEqual([]);
    expect(listDocuments).not.toHaveBeenCalled();
  });

  it("treats an empty DATABASE_URL exactly as the app does: no store, in-process", async () => {
    // `store.ts:11` tests truthiness, so "" selects the in-process store just as unset does.
    vi.stubEnv("DATABASE_URL", "");
    const result = await checkAppMemory.run(context());
    expect(result.status).toBe("warn");
    expect(result.details).toMatchObject({ store: "memory" });
    expect(loaded).toEqual([]);
  });
});

describe("check_app_memory with a database configured", () => {
  it("still measures through the app's own store, one document read per run", async () => {
    vi.stubEnv("DATABASE_URL", "postgresql://localhost/trent");
    const result = await checkAppMemory.run(context());
    expect(result.status).toBe("ok");
    expect(result.message).toContain("durable");
    expect(loaded).toEqual(["@/lib/store"]);
    expect(listDocuments).toHaveBeenCalledTimes(1);
    expect(listDocuments).toHaveBeenCalledWith("co_doctor_probe");
  });

  it("reports the store's own error when the read fails", async () => {
    vi.stubEnv("DATABASE_URL", "file:/tmp/trent.db");
    listDocuments.mockRejectedValueOnce(new Error("the URL must start with the protocol `postgresql://`"));
    const result = await checkAppMemory.run(context());
    expect(result.status).toBe("warn");
    expect(result.details).toMatchObject({ reachable: false, store: "sqlite" });
    expect(loaded).toEqual(["@/lib/store"]);
  });
});

describe("the whole default check list on an empty profile", () => {
  it("runs every check and never evaluates the app's store, its db module or @prisma/client", async () => {
    vi.stubEnv("DATABASE_URL", undefined);
    const runner = new DoctorRunner(configManager, {
      probeTimeoutMs: 150,
      checkTimeoutMs: 5_000,
      // Hermetic: no network and no spawned probe; a check that needs either reports it, and
      // the point here is what gets imported, not what the probes answer.
      fetchImpl: async () => {
        throw new TypeError("fetch failed: offline in this test");
      },
      execImpl: async () => ({ code: 1, stdout: "", stderr: "" }),
    });
    const report = await runner.runAll();
    expect(report.total).toBe(DEFAULT_CHECKS.length);
    const appMemory = report.results.find((r) => r.name === checkAppMemory.name);
    expect(appMemory?.status).toBe("warn");
    expect(loaded).toEqual([]);
  });
});
