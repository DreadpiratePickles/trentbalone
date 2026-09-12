/**
 * `@trent/core` wrapper over `apps/web/lib/agent-marketplace.ts`.
 *
 * The app module builds its product catalog from the static agent catalog, but
 * imports `@/lib/store` for three exports that read or write `agentEntitlement`
 * rows. Those three are deliberately NOT re-exported here:
 *
 *   - `catalogWithAccess(companyId)`   — needs store.listAgentEntitlements
 *   - `grantMockEntitlement(...)`      — needs store.grantAgentEntitlement
 *   - `revokeMockEntitlement(...)`     — needs store.revokeAgentEntitlement
 *
 * Instead `catalogWithAccessFrom()` below takes the entitlement rows as an
 * argument, so a CLI caller supplies them from whatever store it has (SQLite in
 * standalone mode, Postgres in connected mode) without `@trent/core` binding to
 * one. Granting and revoking stay app-only: they are writes behind an audited
 * store transaction and do not belong in a read-side wrapper.
 *
 * The audit flagged that eight of these exports had inferred return types; each
 * is annotated below.
 *
 * Wraps: apps/web/lib/agent-marketplace.ts
 */

import {
  FREE_AGENT_PROFILE_IDS as LIB_FREE_PROFILE_IDS,
  agentMarketplaceProducts as libAgentMarketplaceProducts,
  findAgentProductForProfile as libFindAgentProductForProfile,
  findProduct as libFindProduct,
  hasProfileEntitlement as libHasProfileEntitlement,
  isIncludedProfile as libIsIncludedProfile,
  packProductId as libPackProductId,
  productUnlocksProfile as libProductUnlocksProfile,
  sortCatalogByCapability as libSortCatalogByCapability,
} from "@/lib/agent-marketplace";
import type { CatalogAgent, CatalogCategory } from "../agents/index.js";

export type AgentProduct = {
  id: string;
  kind: "agent" | "pack";
  name: string;
  description: string;
  profileIds: string[];
  category?: CatalogCategory;
  /** Integer cents — never a float. */
  priceCents: number;
  currency: "usd";
  billingMode: "free" | "one_time" | "subscription";
  status: "active";
  stripeLookupKey: string;
};

export type AgentAccessState = "included" | "entitled" | "locked";

/** Mirrors `AgentEntitlement` in apps/web/lib/types.ts. */
export type AgentEntitlementRecord = {
  id: string;
  companyId: string;
  productId: string;
  profileId?: string;
  source: "free" | "mock_purchase" | "stripe" | "admin";
  status: "active" | "revoked" | "expired";
  createdAt: string;
  expiresAt?: string;
};

export type CatalogAgentWithAccess = CatalogAgent & {
  access: AgentAccessState;
  productId: string;
  packProductId: string;
  priceCents: number;
};

/** Profiles every company gets for free. */
export const FREE_AGENT_PROFILE_IDS: readonly string[] = LIB_FREE_PROFILE_IDS;

/** Product id for a whole division pack. */
export function packProductId(category: CatalogCategory): string {
  return libPackProductId(category as Parameters<typeof libPackProductId>[0]);
}

/** All marketplace products: one pack per division plus one per specialist. */
export function agentMarketplaceProducts(): AgentProduct[] {
  return libAgentMarketplaceProducts() as unknown as AgentProduct[];
}

/** The single-agent product for a profile, if one exists. */
export function findAgentProductForProfile(profileId: string): AgentProduct | undefined {
  return libFindAgentProductForProfile(profileId) as AgentProduct | undefined;
}

/** Any product (pack or agent) by product id. */
export function findProduct(productId: string): AgentProduct | undefined {
  return libFindProduct(productId) as AgentProduct | undefined;
}

/** True when buying this product unlocks the given profile. */
export function productUnlocksProfile(product: AgentProduct, profileId: string): boolean {
  return libProductUnlocksProfile(
    product as unknown as Parameters<typeof libProductUnlocksProfile>[0],
    profileId,
  );
}

/** True when the profile is on the free list and needs no entitlement at all. */
export function isIncludedProfile(profileId: string): boolean {
  return libIsIncludedProfile(profileId);
}

/**
 * True when a company may run this profile. Free-list profiles short-circuit to
 * true; otherwise an entitlement must be `active`, unexpired at `at`, and cover
 * the profile either directly or through its pack.
 */
export function hasProfileEntitlement(
  profileId: string,
  entitlements: readonly AgentEntitlementRecord[],
  at: Date = new Date(),
): boolean {
  return libHasProfileEntitlement(
    profileId,
    entitlements as unknown as Parameters<typeof libHasProfileEntitlement>[1],
    at,
  );
}

/** Sort specialists by capability score, then quality label, then name. */
export function sortCatalogByCapability<
  T extends Pick<CatalogAgent, "capability" | "name">,
>(agents: T[]): T[] {
  return libSortCatalogByCapability(
    agents as unknown as Parameters<typeof libSortCatalogByCapability>[0],
  ) as unknown as T[];
}

/**
 * The DB-free half of the app's `catalogWithAccess`: the caller supplies the
 * company's entitlement rows instead of the wrapper reaching for a store.
 */
export function catalogWithAccessFrom(
  agents: readonly CatalogAgent[],
  entitlements: readonly AgentEntitlementRecord[],
  at: Date = new Date(),
): CatalogAgentWithAccess[] {
  const withAccess = agents.map((agent) => {
    const product = findAgentProductForProfile(agent.id);
    const entitled = hasProfileEntitlement(agent.id, entitlements, at);
    const access: AgentAccessState = isIncludedProfile(agent.id)
      ? "included"
      : entitled
        ? "entitled"
        : "locked";
    return {
      ...agent,
      access,
      productId: product?.id ?? `agent.${agent.id}`,
      packProductId: packProductId(agent.category),
      priceCents: product?.priceCents ?? 500,
    };
  });
  return sortCatalogByCapability(withAccess) as CatalogAgentWithAccess[];
}
