import { AGENT_CATALOG, type CatalogAgent, type CatalogCategory } from "@/lib/agent-catalog";
import { store } from "@/lib/store";
import type { AgentEntitlement, AgentQualityLabel } from "@/lib/types";

export type AgentProduct = {
  id: string;
  kind: "agent" | "pack";
  name: string;
  description: string;
  profileIds: string[];
  category?: CatalogCategory;
  priceCents: number;
  currency: "usd";
  billingMode: "free" | "one_time" | "subscription";
  status: "active";
  stripeLookupKey: string;
};

export type AgentAccessState = "included" | "entitled" | "locked";

export type CatalogAgentWithAccess = CatalogAgent & {
  access: AgentAccessState;
  productId: string;
  packProductId: string;
  priceCents: number;
};

export const FREE_AGENT_PROFILE_IDS = [
  "eng-frontend-developer",
  "eng-backend-architect",
  "mkt-growth-hacker",
  "mkt-content-creator",
  "sup-support-responder",
  "test-reality-checker",
  "prod-sprint-prioritizer",
  "pm-studio-producer",
  "sup-legal-compliance-checker"
];

const PACK_PRICES: Record<CatalogCategory, number> = {
  engineering: 1900,
  design: 1500,
  "paid-media": 1700,
  sales: 1600,
  marketing: 1700,
  product: 1400,
  "project-management": 1200,
  testing: 1300,
  support: 1100,
  finance: 1300,
  "spatial-computing": 2100,
  academic: 900,
  specialized: 2500
};

function agentProductId(profileId: string) {
  return `agent.${profileId}`;
}

export function packProductId(category: CatalogCategory) {
  return `pack.${category}`;
}

export function agentMarketplaceProducts(): AgentProduct[] {
  const packs = (Object.keys(PACK_PRICES) as CatalogCategory[]).map((category) => {
    const profileIds = AGENT_CATALOG.filter((agent) => agent.category === category).map((agent) => agent.id);
    return {
      id: packProductId(category),
      kind: "pack" as const,
      name: `${category.replace(/-/g, " ")} pack`,
      description: `Unlock all ${profileIds.length} ${category.replace(/-/g, " ")} specialist profiles.`,
      profileIds,
      category,
      priceCents: PACK_PRICES[category],
      currency: "usd" as const,
      billingMode: "subscription" as const,
      status: "active" as const,
      stripeLookupKey: `trent_${packProductId(category).replace(/\./g, "_")}`
    };
  });

  const agents = AGENT_CATALOG.map((agent) => {
    const included = FREE_AGENT_PROFILE_IDS.includes(agent.id);
    return {
      id: agentProductId(agent.id),
      kind: "agent" as const,
      name: agent.name,
      description: agent.whenToUse,
      profileIds: [agent.id],
      category: agent.category,
      priceCents: included ? 0 : 500,
      currency: "usd" as const,
      billingMode: included ? ("free" as const) : ("one_time" as const),
      status: "active" as const,
      stripeLookupKey: `trent_${agentProductId(agent.id).replace(/\./g, "_")}`
    };
  });

  return [...packs, ...agents];
}

export function findAgentProductForProfile(profileId: string) {
  return agentMarketplaceProducts().find(
    (product) => product.kind === "agent" && product.profileIds.includes(profileId)
  );
}

export function findProduct(productId: string) {
  return agentMarketplaceProducts().find((product) => product.id === productId);
}

export function productUnlocksProfile(product: AgentProduct, profileId: string) {
  return product.profileIds.includes(profileId);
}

export function isIncludedProfile(profileId: string) {
  return FREE_AGENT_PROFILE_IDS.includes(profileId);
}

export function hasProfileEntitlement(
  profileId: string,
  entitlements: AgentEntitlement[],
  at = new Date()
) {
  if (isIncludedProfile(profileId)) return true;
  return entitlements.some((entitlement) => {
    if (entitlement.status !== "active") return false;
    if (entitlement.expiresAt && new Date(entitlement.expiresAt) <= at) return false;
    const product = findProduct(entitlement.productId);
    if (!product) return false;
    return entitlement.profileId === profileId || productUnlocksProfile(product, profileId);
  });
}

export async function catalogWithAccess(companyId: string): Promise<CatalogAgentWithAccess[]> {
  const entitlements = await store.listAgentEntitlements(companyId);
  return AGENT_CATALOG.map((agent) => {
    const product = findAgentProductForProfile(agent.id);
    const entitled = hasProfileEntitlement(agent.id, entitlements);
    const access: AgentAccessState = isIncludedProfile(agent.id) ? "included" : entitled ? "entitled" : "locked";
    return {
      ...agent,
      access,
      productId: product?.id ?? agentProductId(agent.id),
      packProductId: packProductId(agent.category),
      priceCents: product?.priceCents ?? 500
    };
  }).sort(compareCatalogCapability);
}

export function sortCatalogByCapability<T extends Pick<CatalogAgent, "capability" | "name">>(agents: T[]): T[] {
  return [...agents].sort(compareCatalogCapability);
}

function compareCatalogCapability<T extends Pick<CatalogAgent, "capability" | "name">>(left: T, right: T): number {
  const scoreDelta = capabilityScore(right) - capabilityScore(left);
  if (scoreDelta !== 0) return scoreDelta;
  const labelDelta = qualityWeight(right.capability?.qualityLabel) - qualityWeight(left.capability?.qualityLabel);
  if (labelDelta !== 0) return labelDelta;
  return left.name.localeCompare(right.name);
}

function capabilityScore(agent: Pick<CatalogAgent, "capability">): number {
  return typeof agent.capability?.score === "number" ? agent.capability.score : -1;
}

function qualityWeight(label: AgentQualityLabel | undefined): number {
  if (label === "autonomous") return 3;
  if (label === "supervised") return 2;
  if (label === "experimental") return 1;
  return 0;
}

export async function grantMockEntitlement(companyId: string, productId: string) {
  const product = findProduct(productId);
  if (!product) throw new Error("Agent marketplace product not found");
  const profileId = product.kind === "agent" ? product.profileIds[0] : undefined;
  return store.grantAgentEntitlement({
    companyId,
    productId: product.id,
    profileId,
    source: product.billingMode === "free" ? "free" : "mock_purchase",
    status: "active"
  });
}

export async function revokeMockEntitlement(companyId: string, productId: string) {
  const product = findProduct(productId);
  if (!product) throw new Error("Agent marketplace product not found");
  return store.revokeAgentEntitlement(companyId, product.id);
}
