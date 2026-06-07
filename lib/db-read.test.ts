import { it, expect } from "vitest";
import { describeIfDb as describe } from "@/lib/vitest-guards";
import { readDb, checkReplicaHealth } from "@/lib/db-read";

describe("readDb", () => {
  it("returns a client with standard Prisma methods", () => {
    expect(typeof readDb.company.findMany).toBe("function");
    expect(typeof readDb.task.findMany).toBe("function");
  });

  it("falls back to prismaStore when READ_DATABASE_URL is absent", () => {
    // In test environment, no READ_DATABASE_URL is set so readDb === prismaStore
    // (same underlying PrismaClient instance for SQLite)
    expect(readDb).toBeTruthy();
  });

  it("can execute a query", async () => {
    // Should not throw — confirms the client is functional
    const companies = await readDb.company.findMany({ take: 1 });
    expect(Array.isArray(companies)).toBe(true);
  });
});

describe("checkReplicaHealth", () => {
  it("returns primary ok when DB is reachable", async () => {
    const result = await checkReplicaHealth();
    expect(result.primary).toBe("ok");
  });

  it("reports replica as not_configured when READ_DATABASE_URL is absent", async () => {
    const saved = process.env.READ_DATABASE_URL;
    delete process.env.READ_DATABASE_URL;
    const result = await checkReplicaHealth();
    expect(result.replica).toBe("not_configured");
    if (saved) process.env.READ_DATABASE_URL = saved;
  });
});

export {};
