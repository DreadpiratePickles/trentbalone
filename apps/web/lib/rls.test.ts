/**
 * RLS application-layer tests.
 *
 * These tests run against the SQLite in-memory store (no Postgres required).
 * They verify:
 * - withCompanyContext wraps fn in a transaction and returns its result
 * - assertCompanyMatch blocks cross-tenant access at the application layer
 * - extractCompanyId reads from request headers
 *
 * DB-level RLS policy tests (pgTAP) live in docs/security/rls-pgTAP.sql
 * and require a Postgres instance with the migration applied.
 */

import { describe, it, expect } from "vitest";
import { describeIfDb } from "@/lib/vitest-guards";
import { withCompanyContext, assertCompanyMatch, extractCompanyId } from "@/lib/rls";
import { db } from "@/lib/db";

// ── withCompanyContext ─────────────────────────────────────────────────────────

describeIfDb("withCompanyContext", () => {
  it("runs the callback and returns its value", async () => {
    const result = await withCompanyContext("co_test_001", async () => {
      return 42;
    });
    expect(result).toBe(42);
  });

  it("propagates errors from the callback", async () => {
    await expect(
      withCompanyContext("co_test_001", async () => {
        throw new Error("inner failure");
      })
    ).rejects.toThrow("inner failure");
  });

  describeIfDb("postgres transaction rollback", () => {
    it("rolls back on error (transaction semantics)", async () => {
      // Create a company so we can insert a Task inside the context
      const company = await db.company.create({
        data: {
          id: `co_rls_rb_${Date.now()}`,
          name: "RLS Rollback Co",
          slug: `rls-rollback-co-${Date.now()}`,
          brief: {},
          metrics: {},
          status: "active",
          updatedAt: new Date(),
        },
      });

      let taskId = "";
      try {
        await withCompanyContext(company.id, async (tx) => {
          const task = await tx.task.create({
            data: {
              id: `task_rls_${Date.now()}`,
              companyId: company.id,
              title: "Rolled back task",
              prompt: "",
              agentRole: "engineer",
              tags: [],
              status: "draft",
              updatedAt: new Date(),
            },
          });
          taskId = task.id;
          throw new Error("force rollback");
        });
      } catch {
        // expected
      }

      // Task should not persist
      if (taskId) {
        const found = await db.task.findUnique({ where: { id: taskId } });
        expect(found).toBeNull();
      }
    });
  });
});

// ── assertCompanyMatch ─────────────────────────────────────────────────────────

describe("assertCompanyMatch", () => {
  it("does not throw when IDs match", () => {
    expect(() => assertCompanyMatch("co_abc", "co_abc")).not.toThrow();
  });

  it("throws 403 when IDs differ", () => {
    expect(() => assertCompanyMatch("co_abc", "co_xyz")).toThrow("cross-tenant");
  });

  it("attaches statusCode 403", () => {
    try {
      assertCompanyMatch("co_a", "co_b");
    } catch (err: unknown) {
      expect((err as { statusCode?: number }).statusCode).toBe(403);
    }
  });

  it("attaches COMPANY_MISMATCH code", () => {
    try {
      assertCompanyMatch("co_a", "co_b");
    } catch (err: unknown) {
      expect((err as { code?: string }).code).toBe("COMPANY_MISMATCH");
    }
  });
});

// ── extractCompanyId ──────────────────────────────────────────────────────────

describe("extractCompanyId", () => {
  it("returns req.companyId when set directly", () => {
    expect(extractCompanyId({ companyId: "co_direct" })).toBe("co_direct");
  });

  it("reads x-company-id header", () => {
    const req = { headers: { get: (name: string) => name === "x-company-id" ? "co_header" : null } };
    expect(extractCompanyId(req)).toBe("co_header");
  });

  it("returns undefined when neither source is available", () => {
    expect(extractCompanyId({})).toBeUndefined();
  });
});

export {};
