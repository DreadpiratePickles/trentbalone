// app/api/health/route.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { checkBackupHealth, dbQueryRaw, readWorkerHeartbeat } = vi.hoisted(() => ({
  checkBackupHealth: vi.fn(),
  dbQueryRaw: vi.fn(),
  readWorkerHeartbeat: vi.fn(),
}));
vi.mock("@/lib/backup-health", () => ({ checkBackupHealth }));
vi.mock("@/lib/db", () => ({ db: { $queryRaw: dbQueryRaw } }));
vi.mock("@/lib/worker-heartbeat", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/worker-heartbeat")>();
  return {
    ...actual,
    readWorkerHeartbeat,
  };
});

import { GET } from "./route";
import { buildHealthReadiness } from "@/lib/health-readiness";

const savedEnv = { ...process.env };

describe("GET /api/health — backup field", () => {
  beforeEach(() => {
    checkBackupHealth.mockReturnValue({ ok: true, ageHours: 2.1, path: "/backups/x.enc" });
    dbQueryRaw.mockResolvedValue([{ "?column?": 1 }]);
    readWorkerHeartbeat.mockResolvedValue(new Date().toISOString());
    process.env.OPENAI_API_KEY = "sk-test";
    process.env.DATABASE_URL = "postgresql://trent:trentdev@localhost:5432/trent";
    process.env.REDIS_URL = "redis://localhost:6379";
  });

  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it("includes backup.ok=true when backup is healthy", async () => {
    checkBackupHealth.mockReturnValue({ ok: true, ageHours: 2.1, path: "/backups/x.enc" });
    const res = await GET();
    const body = await res.json();
    expect(body.backup.ok).toBe(true);
    expect(body.backup.ageHours).toBeCloseTo(2.1);
  });

  it("includes backup.ok=false when backup is stale", async () => {
    checkBackupHealth.mockReturnValue({ ok: false, error: "backup is stale", ageHours: 30, path: null });
    const res = await GET();
    const body = await res.json();
    expect(body.backup.ok).toBe(false);
    expect(body.status).toBe("degraded");
  });
});

describe("GET /api/health — readiness flags", () => {
  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it("reports llm/db/redis readiness without leaking secrets", async () => {
    checkBackupHealth.mockReturnValue({ ok: true, ageHours: 1, path: "/backups/x.enc" });
    dbQueryRaw.mockResolvedValue([{ "?column?": 1 }]);
    process.env.OPENAI_API_KEY = "sk-secret-value";
    process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/trent";
    process.env.REDIS_URL = "redis://localhost:6379";

    const res = await GET();
    const body = await res.json();

    expect(body.readiness).toEqual({
      ok: true,
      llm: true,
      db: "postgres",
      redis: true,
    });
    expect(JSON.stringify(body)).not.toContain("sk-secret");
    expect(JSON.stringify(body)).not.toContain("pass");
  });

  it("reports memory db and missing llm/redis when unset", async () => {
    checkBackupHealth.mockReturnValue({ ok: true, ageHours: 1, path: "/backups/x.enc" });
    readWorkerHeartbeat.mockResolvedValue(null);
    delete process.env.OPENAI_API_KEY;
    delete process.env.DATABASE_URL;
    delete process.env.REDIS_URL;

    const res = await GET();
    const body = await res.json();

    expect(body.readiness).toEqual({
      ok: false,
      llm: false,
      db: "memory",
      redis: false,
    });
    expect(body.worker).toEqual({ seenAt: null, alive: false });
  });

  it("includes worker heartbeat when present", async () => {
    checkBackupHealth.mockReturnValue({ ok: true, ageHours: 1, path: "/backups/x.enc" });
    dbQueryRaw.mockResolvedValue([{ "?column?": 1 }]);
    const seenAt = new Date().toISOString();
    readWorkerHeartbeat.mockResolvedValue(seenAt);

    const res = await GET();
    const body = await res.json();

    expect(body.worker.seenAt).toBe(seenAt);
    expect(body.worker.alive).toBe(true);
  });
});

describe("buildHealthReadiness", () => {
  it("classifies postgres when DATABASE_URL is set", () => {
    expect(
      buildHealthReadiness({
        OPENAI_API_KEY: "sk-x",
        DATABASE_URL: "postgresql://localhost/trent",
        REDIS_URL: "",
      } as unknown as NodeJS.ProcessEnv).db,
    ).toBe("postgres");
  });
});
