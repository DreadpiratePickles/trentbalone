/**
 * lib/provisioning/cost-attributor.test.ts — TDD
 *
 * Per-company infra cost tracking wired to the Phase 2 ledger.
 *
 * Key invariants:
 *   - cost-attributor reads from provisioner integration records, never calls provider APIs directly
 *   - every cost event writes a ledger entry (Phase 2 dependency)
 *   - recordProvisioningCost() is idempotent by (companyId, resourceId, period) — no duplicate entries
 *   - getCostSummary() aggregates all provisioning ledger entries for a company
 */

import { describe, it, expect, vi } from "vitest";
import {
  recordProvisioningCost,
  getCostSummary,
  type ProvisioningCostEntry,
} from "@/lib/provisioning/cost-attributor";
import { store } from "@/lib/store";

describe("cost-attributor — recordProvisioningCost()", () => {
  it("writes a ledger entry for a provisioning cost event", async () => {
    const company = await store.createCompany({
      name: `Cost Record ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" },
    });

    await recordProvisioningCost({
      companyId: company.id,
      resourceType: "neon_project",
      resourceId: "neon-proj-abc",
      amountCents: 1500,
      description: "Neon Postgres — Jan 2026",
      period: "2026-01",
    });

    const summary = await getCostSummary(company.id);
    expect(summary.totalCents).toBe(1500);
    expect(summary.entries).toHaveLength(1);
    expect(summary.entries[0].resourceType).toBe("neon_project");
  });

  it("accumulates multiple cost entries for different resources", async () => {
    const company = await store.createCompany({
      name: `Cost Multi ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" },
    });

    await recordProvisioningCost({
      companyId: company.id,
      resourceType: "vercel_project",
      resourceId: "prj-vercel-x",
      amountCents: 2000,
      description: "Vercel Pro — Jan 2026",
      period: "2026-01",
    });
    await recordProvisioningCost({
      companyId: company.id,
      resourceType: "r2_bucket",
      resourceId: "trent-acme-co",
      amountCents: 200,
      description: "Cloudflare R2 — Jan 2026",
      period: "2026-01",
    });

    const summary = await getCostSummary(company.id);
    expect(summary.totalCents).toBe(2200);
    expect(summary.entries).toHaveLength(2);
  });

  it("does not double-count when called twice for the same resource+period", async () => {
    const company = await store.createCompany({
      name: `Cost Idem ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" },
    });

    await recordProvisioningCost({
      companyId: company.id,
      resourceType: "neon_project",
      resourceId: "neon-proj-idem",
      amountCents: 1500,
      description: "Neon — Jan 2026",
      period: "2026-01",
    });
    // Calling again with the same period is idempotent — no duplicate
    await recordProvisioningCost({
      companyId: company.id,
      resourceType: "neon_project",
      resourceId: "neon-proj-idem",
      amountCents: 1500,
      description: "Neon — Jan 2026",
      period: "2026-01",
    });

    const summary = await getCostSummary(company.id);
    expect(summary.entries.filter((e) => e.resourceId === "neon-proj-idem")).toHaveLength(1);
    expect(summary.totalCents).toBe(1500);
  });
});

describe("cost-attributor — getCostSummary()", () => {
  it("returns empty summary when no costs recorded", async () => {
    const company = await store.createCompany({
      name: `Cost Empty ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" },
    });

    const summary = await getCostSummary(company.id);
    expect(summary.totalCents).toBe(0);
    expect(summary.entries).toHaveLength(0);
  });

  it("does not include costs from other companies", async () => {
    const companyA = await store.createCompany({
      name: `Cost IsolA ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" },
    });
    const companyB = await store.createCompany({
      name: `Cost IsolB ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" },
    });

    await recordProvisioningCost({
      companyId: companyA.id,
      resourceType: "neon_project",
      resourceId: "neon-a",
      amountCents: 3000,
      description: "Neon A",
      period: "2026-01",
    });

    const summaryB = await getCostSummary(companyB.id);
    expect(summaryB.totalCents).toBe(0);
    expect(summaryB.entries).toHaveLength(0);
  });

  it("groups costs by resource type", async () => {
    const company = await store.createCompany({
      name: `Cost Group ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" },
    });

    await recordProvisioningCost({
      companyId: company.id, resourceType: "neon_project", resourceId: "n1",
      amountCents: 1500, description: "Neon", period: "2026-01",
    });
    await recordProvisioningCost({
      companyId: company.id, resourceType: "neon_project", resourceId: "n1",
      amountCents: 1500, description: "Neon", period: "2026-02",
    });
    await recordProvisioningCost({
      companyId: company.id, resourceType: "r2_bucket", resourceId: "b1",
      amountCents: 200, description: "R2", period: "2026-01",
    });

    const summary = await getCostSummary(company.id);
    expect(summary.byResourceType["neon_project"]).toBe(3000);
    expect(summary.byResourceType["r2_bucket"]).toBe(200);
    expect(summary.totalCents).toBe(3200);
  });
});
