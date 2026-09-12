import { describe, it, expect } from "vitest";
import {
  FREE_AGENT_PROFILE_IDS,
  agentMarketplaceProducts,
  findAgentProductForProfile,
  findProduct,
  hasProfileEntitlement,
  packProductId,
  type AgentEntitlementRecord,
} from "./index.js";

const PAID_PROFILE = "eng-ai-engineer";

describe("marketplace wrapper — products", () => {
  it("publishes exactly 13 category packs alongside one product per agent", () => {
    const products = agentMarketplaceProducts();
    const packs = products.filter((p) => p.kind === "pack");
    const agents = products.filter((p) => p.kind === "agent");
    expect(packs).toHaveLength(13);
    expect(agents).toHaveLength(164);
    expect(products).toHaveLength(177);
  });

  it("prices the engineering pack at 1900 integer cents", () => {
    const pack = findProduct(packProductId("engineering"));
    expect(pack?.priceCents).toBe(1900);
    expect(pack?.currency).toBe("usd");
    expect(pack?.billingMode).toBe("subscription");
    expect(pack?.profileIds).toHaveLength(29);
  });

  it("prices free-list agents at zero and everyone else at 500 cents", () => {
    expect(findAgentProductForProfile("eng-frontend-developer")?.priceCents).toBe(0);
    expect(findAgentProductForProfile("eng-frontend-developer")?.billingMode).toBe("free");
    expect(findAgentProductForProfile(PAID_PROFILE)?.priceCents).toBe(500);
  });
});

describe("marketplace wrapper — entitlement checks", () => {
  it("short-circuits a free-list profile with no entitlements at all", () => {
    expect(FREE_AGENT_PROFILE_IDS).toContain("eng-frontend-developer");
    expect(hasProfileEntitlement("eng-frontend-developer", [])).toBe(true);
  });

  it("refuses a paid profile whose pack entitlement has expired", () => {
    const expired: AgentEntitlementRecord = {
      id: "ent_1",
      companyId: "co_1",
      productId: packProductId("engineering"),
      source: "stripe",
      status: "active",
      createdAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2026-06-01T00:00:00.000Z",
    };
    const at = new Date("2026-09-01T00:00:00.000Z");
    expect(hasProfileEntitlement(PAID_PROFILE, [expired], at)).toBe(false);
    // The same entitlement, still in date, does unlock the profile.
    expect(
      hasProfileEntitlement(PAID_PROFILE, [{ ...expired, expiresAt: "2026-12-01T00:00:00.000Z" }], at),
    ).toBe(true);
  });

  it("refuses a revoked entitlement even before its expiry", () => {
    const revoked: AgentEntitlementRecord = {
      id: "ent_2",
      companyId: "co_1",
      productId: packProductId("engineering"),
      source: "stripe",
      status: "revoked",
      createdAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2026-12-01T00:00:00.000Z",
    };
    expect(hasProfileEntitlement(PAID_PROFILE, [revoked], new Date("2026-09-01T00:00:00.000Z"))).toBe(false);
  });
});
