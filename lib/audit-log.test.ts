import { describe, it, expect } from "vitest";
import { describeIfDb } from "@/lib/vitest-guards";
import { db } from "@/lib/db";
import { store } from "@/lib/store";
import { computeAuditHash, appendAuditLog, verifyAuditChain } from "./audit-log";

async function makeCompany() {
  return store.createCompany({
    name: `Audit Test ${Math.random().toString(36).slice(2)}`,
    brief: { vision: "test" },
  });
}

describe("computeAuditHash", () => {
  it("returns a 64-char hex string", () => {
    const h = computeAuditHash("genesis", "id1", "user", "task.create", "obj1", "Created task", "2026-01-01T00:00:00.000Z");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it("same inputs always produce same hash", () => {
    const h1 = computeAuditHash("genesis", "id1", "user", "task.create", "obj1", "summary", "2026-01-01T00:00:00.000Z");
    const h2 = computeAuditHash("genesis", "id1", "user", "task.create", "obj1", "summary", "2026-01-01T00:00:00.000Z");
    expect(h1).toBe(h2);
  });

  it("different prevHash produces different hash", () => {
    const h1 = computeAuditHash("genesis", "id1", "user", "task.create", "obj1", "summary", "2026-01-01T00:00:00.000Z");
    const h2 = computeAuditHash("different", "id1", "user", "task.create", "obj1", "summary", "2026-01-01T00:00:00.000Z");
    expect(h1).not.toBe(h2);
  });
});

describeIfDb("appendAuditLog", () => {
  it("uses 'genesis' as prevHash for the first entry in the chain", async () => {
    // Use a fresh company; store.createCompany writes the genesis entry itself.
    const company = await makeCompany();
    const first = await db.auditLog.findFirst({
      where: { companyId: company.id },
      orderBy: { createdAt: "asc" },
    });
    expect(first?.prevHash).toBe("genesis");
    expect(first?.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("uses last entry hash as prevHash for subsequent entries", async () => {
    const company = await makeCompany();
    await appendAuditLog(company.id, "user", "task.create", "task", "obj1", "First");
    await appendAuditLog(company.id, "agent", "task.update", "task", "obj1", "Second");

    const rows = await db.auditLog.findMany({
      where: { companyId: company.id },
      orderBy: { createdAt: "asc" },
    });
    // 1 company.create entry + 2 appended = 3 total
    expect(rows).toHaveLength(3);
    // Each entry must chain to the previous one's hash
    expect(rows[1].prevHash).toBe(rows[0].hash);
    expect(rows[2].prevHash).toBe(rows[1].hash);
  });

  it("persists all required fields", async () => {
    const company = await makeCompany();
    await appendAuditLog(company.id, "system", "job.started", "job_run", "job1", "Job started");

    const row = await db.auditLog.findFirst({
      where: { companyId: company.id, action: "job.started" },
    });
    expect(row).toMatchObject({
      companyId: company.id,
      actor: "system",
      action: "job.started",
      objectType: "job_run",
      objectId: "job1",
      summary: "Job started",
    });
    expect(row?.id).toBeTruthy();
    expect(row?.createdAt).toBeInstanceOf(Date);
  });
});

describeIfDb("verifyAuditChain", () => {
  it("returns valid=true, count=1 for a new company (company.create entry)", async () => {
    const company = await makeCompany();
    const result = await verifyAuditChain(company.id);
    // store.createCompany writes a company.create audit entry in its own transaction
    expect(result).toEqual({ valid: true, count: 1 });
  });

  it("returns valid=true for a correctly chained set of entries", async () => {
    const company = await makeCompany();
    await appendAuditLog(company.id, "user", "a.b", "task", "o1", "s1");
    await appendAuditLog(company.id, "agent", "c.d", "task", "o2", "s2");

    const result = await verifyAuditChain(company.id);
    // 1 from company.create + 2 appended = 3
    expect(result).toEqual({ valid: true, count: 3 });
  });

  it("returns valid=false and brokenAt when a stored hash is tampered", async () => {
    const company = await makeCompany();
    await appendAuditLog(company.id, "user", "a.b", "task", "o1", "s1");

    const row = await db.auditLog.findFirst({ where: { companyId: company.id } });
    await db.auditLog.update({ where: { id: row!.id }, data: { hash: "tampered_hash" } });

    const result = await verifyAuditChain(company.id);
    expect(result.valid).toBe(false);
    expect(result.brokenAt).toBe(row!.id);
  });
});
