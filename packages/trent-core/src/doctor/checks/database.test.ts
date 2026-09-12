import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ConfigManager } from "../../config/ConfigManager.js";
import { checkDatabase, sqlitePathFor } from "./database.js";
import type { DoctorContext } from "../types.js";

let tempDir: string;
let configManager: ConfigManager;

const context = (over: Partial<DoctorContext> = {}): DoctorContext => ({
  baseDir: tempDir,
  profile: "default",
  configManager,
  probeTimeoutMs: 200,
  ...over,
});

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-db-"));
  configManager = new ConfigManager({ baseDir: tempDir });
  configManager.ensureDirs();
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function makeDb(journalMode: "wal" | "delete"): string {
  const dbPath = sqlitePathFor(configManager);
  const db = new DatabaseSync(dbPath);
  db.exec(`PRAGMA journal_mode = ${journalMode};`);
  db.exec("CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY);");
  db.exec("INSERT INTO runs (id) VALUES ('run_1');");
  db.close();
  return dbPath;
}

describe("database check, standalone mode", () => {
  it("warns when the database file does not exist yet", async () => {
    const result = await checkDatabase.run(context({ mode: "standalone" }));
    expect(result.status).toBe("warn");
    expect(result.fixHint).toBeTruthy();
  });

  it("passes with integrity ok and journal_mode wal", async () => {
    makeDb("wal");
    const result = await checkDatabase.run(context({ mode: "standalone" }));
    expect(result.status).toBe("ok");
    expect(result.details?.journalMode).toBe("wal");
    expect(result.details?.integrity).toBe("ok");
  });

  it("warns when journal_mode is not wal and offers a fix", async () => {
    makeDb("delete");
    const result = await checkDatabase.run(context({ mode: "standalone" }));
    expect(result.status).toBe("warn");
    expect(result.message).toContain("wal");
    expect(result.fixHint).toBeTruthy();
  });

  it("fails on a deliberately corrupted database file", async () => {
    const dbPath = makeDb("delete");
    // Scribble over the tail of the file, where the b-tree cells live: the header still parses
    // and the file still opens, but PRAGMA integrity_check must refuse it.
    const size = fs.statSync(dbPath).size;
    const handle = fs.openSync(dbPath, "r+");
    fs.writeSync(handle, Buffer.alloc(1024, 0x41), 0, 1024, Math.max(size - 1024, 100));
    fs.closeSync(handle);
    const result = await checkDatabase.run(context({ mode: "standalone" }));
    expect(result.status).toBe("fail");
    expect(result.fixHint).toBeTruthy();
  });

  it("fails on a file that is not a database at all", async () => {
    fs.writeFileSync(sqlitePathFor(configManager), "this is not a sqlite file");
    const result = await checkDatabase.run(context({ mode: "standalone" }));
    expect(result.status).toBe("fail");
  });
});

describe("database check, connected mode", () => {
  const health = (body: unknown, status = 200): Partial<DoctorContext> => ({
    mode: "connected",
    healthUrl: "https://trent.example.test/api/health",
    fetchImpl: async () => new Response(JSON.stringify(body), { status }),
  });

  it("warns when the app is running on the in-memory fallback", async () => {
    const result = await checkDatabase.run(
      context(
        health({ status: "ok", checks: { database: "ok" }, readiness: { db: "memory" } }),
      ),
    );
    expect(result.status).toBe("warn");
    expect(result.message.toLowerCase()).toContain("memory");
    expect(result.message).toContain("DATABASE_URL");
    expect(result.details?.readinessDb).toBe("memory");
  });

  it("passes when the health endpoint reports a real database", async () => {
    const result = await checkDatabase.run(
      context(health({ status: "ok", checks: { database: "ok" }, readiness: { db: "postgres" } })),
    );
    expect(result.status).toBe("ok");
    expect(result.details?.readinessDb).toBe("postgres");
  });

  it("fails when the health endpoint reports a database error", async () => {
    const result = await checkDatabase.run(
      context(health({ status: "error", checks: { database: "error" }, readiness: { db: "postgres" } }, 503)),
    );
    expect(result.status).toBe("fail");
  });

  it("warns when the health endpoint is unreachable", async () => {
    const result = await checkDatabase.run(
      context({
        mode: "connected",
        healthUrl: "https://trent.example.test/api/health",
        fetchImpl: async () => {
          throw new TypeError("fetch failed");
        },
      }),
    );
    expect(result.status).toBe("warn");
  });
});
