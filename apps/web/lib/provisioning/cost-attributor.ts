/**
 * lib/provisioning/cost-attributor.ts
 *
 * Per-company infra cost tracking — wired to the Phase 2 usage ledger.
 *
 * Design:
 *   - Reads from provisioner integration records and caller-supplied cost inputs.
 *   - Never calls provisioner APIs directly.
 *   - Every cost event writes a UsageLedgerEntry with category="infra".
 *   - Idempotent by (companyId, resourceId, period): calling twice for the same
 *     resource+period is a no-op (detected by scanning metadata in the ledger).
 *   - getCostSummary() aggregates all infra ledger entries for a company.
 */

import { store } from "@/lib/store";
import { makeId } from "@/lib/utils";

// ── Public types ──────────────────────────────────────────────────────────────

export type ProvisioningCostEntry = {
  companyId: string;
  /** The provisioned resource type, e.g. "neon_project", "vercel_project", "r2_bucket" */
  resourceType: string;
  /** The resource identifier (project ID, bucket name, etc.) */
  resourceId: string;
  /** Cost in cents for this billing period */
  amountCents: number;
  /** Human-readable description, e.g. "Neon Postgres — Jan 2026" */
  description: string;
  /** Billing period in YYYY-MM format, used for idempotency */
  period: string;
};

export type CostSummary = {
  totalCents: number;
  entries: Array<{
    id: string;
    resourceType: string;
    resourceId: string;
    amountCents: number;
    description: string;
    period: string;
    createdAt: string;
  }>;
  byResourceType: Record<string, number>;
};

// ── recordProvisioningCost() ──────────────────────────────────────────────────

/**
 * Record a provisioning cost event in the Phase 2 usage ledger.
 * Idempotent: if an entry already exists for (companyId, resourceId, period), skips.
 */
export async function recordProvisioningCost(entry: ProvisioningCostEntry): Promise<void> {
  const { companyId, resourceType, resourceId, amountCents, description, period } = entry;

  // Idempotency check: scan existing infra entries for this company
  const existing = await store.listUsage(companyId);
  const duplicate = existing.find(
    (u) =>
      u.category === "infra" &&
      u.metadata["resourceId"] === resourceId &&
      u.metadata["period"] === period
  );
  if (duplicate) return;

  await store.addUsage({
    companyId,
    category: "infra",
    description,
    amountCents,
    metadata: {
      resourceType,
      resourceId,
      period,
    },
  });
}

// ── getCostSummary() ──────────────────────────────────────────────────────────

/**
 * Aggregate all provisioning cost entries for a company from the Phase 2 ledger.
 */
export async function getCostSummary(companyId: string): Promise<CostSummary> {
  const allUsage = await store.listUsage(companyId);
  const infraEntries = allUsage.filter((u) => u.category === "infra");

  const entries = infraEntries.map((u) => ({
    id: u.id,
    resourceType: String(u.metadata["resourceType"] ?? "unknown"),
    resourceId: String(u.metadata["resourceId"] ?? "unknown"),
    amountCents: u.amountCents,
    description: u.description,
    period: String(u.metadata["period"] ?? ""),
    createdAt: u.createdAt,
  }));

  const totalCents = entries.reduce((sum, e) => sum + e.amountCents, 0);

  const byResourceType: Record<string, number> = {};
  for (const e of entries) {
    byResourceType[e.resourceType] = (byResourceType[e.resourceType] ?? 0) + e.amountCents;
  }

  return { totalCents, entries, byResourceType };
}
