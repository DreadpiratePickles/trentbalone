import { describe, expect, it } from "vitest";
import { AGENT_CATALOG } from "@/lib/agent-catalog";
import {
  catalogWithAccess,
  findAgentProductForProfile,
  grantMockEntitlement,
  hasProfileEntitlement,
  isIncludedProfile,
  packProductId,
  revokeMockEntitlement,
  sortCatalogByCapability
} from "@/lib/agent-marketplace";
import { store } from "@/lib/store";

describe("Agent Plug marketplace", () => {
  it("marks included profiles as assignable without an entitlement", async () => {
    const company = await store.createCompany({
      name: "Included Agent Marketplace Co",
      brief: { vision: "Let teams plug in starter specialists" }
    });
    const profile = AGENT_CATALOG.find((agent) => isIncludedProfile(agent.id));
    expect(profile).toBeDefined();

    const catalog = await catalogWithAccess(company.id);
    const row = catalog.find((agent) => agent.id === profile!.id);

    expect(row?.access).toBe("included");
    expect(hasProfileEntitlement(profile!.id, [])).toBe(true);
  });

  it("locks premium profiles until a matching product is purchased", async () => {
    const company = await store.createCompany({
      name: "Premium Agent Marketplace Co",
      brief: { vision: "Unlock specialists through in-app purchases" }
    });
    const profile = AGENT_CATALOG.find((agent) => !isIncludedProfile(agent.id));
    expect(profile).toBeDefined();

    const before = await catalogWithAccess(company.id);
    expect(before.find((agent) => agent.id === profile!.id)?.access).toBe("locked");

    const product = findAgentProductForProfile(profile!.id);
    expect(product).toBeDefined();
    await grantMockEntitlement(company.id, product!.id);

    const after = await catalogWithAccess(company.id);
    expect(after.find((agent) => agent.id === profile!.id)?.access).toBe("entitled");
  });

  it("unlocks every profile in a purchased category pack", async () => {
    const company = await store.createCompany({
      name: "Pack Agent Marketplace Co",
      brief: { vision: "Unlock full divisions when a team needs depth" }
    });
    const category = "marketing";
    const productId = packProductId(category);
    await grantMockEntitlement(company.id, productId);

    const catalog = await catalogWithAccess(company.id);
    const marketingProfiles = catalog.filter((agent) => agent.category === category);

    expect(marketingProfiles.length).toBeGreaterThan(1);
    expect(marketingProfiles.every((agent) => agent.access !== "locked")).toBe(true);
  });

  it("revokes a mock entitlement and locks premium profiles again", async () => {
    const company = await store.createCompany({
      name: "Revoked Agent Marketplace Co",
      brief: { vision: "Keep entitlement lifecycle reversible for billing webhooks" }
    });
    const profile = AGENT_CATALOG.find((agent) => !isIncludedProfile(agent.id));
    expect(profile).toBeDefined();
    const product = findAgentProductForProfile(profile!.id);
    expect(product).toBeDefined();

    await grantMockEntitlement(company.id, product!.id);
    const unlocked = await catalogWithAccess(company.id);
    expect(unlocked.find((agent) => agent.id === profile!.id)?.access).toBe("entitled");

    const revoked = await revokeMockEntitlement(company.id, product!.id);
    expect(revoked).toHaveLength(1);

    const locked = await catalogWithAccess(company.id);
    expect(locked.find((agent) => agent.id === profile!.id)?.access).toBe("locked");
  });

  it("ranks marketplace profiles by measured capability score first", () => {
    const ranked = sortCatalogByCapability([
      { name: "Low", capability: { score: 10, qualityLabel: "supervised" } },
      { name: "Unknown", capability: { score: null, qualityLabel: "experimental" } },
      { name: "High", capability: { score: 90, qualityLabel: "supervised" } },
    ]);

    expect(ranked.map((agent) => agent.name)).toEqual(["High", "Low", "Unknown"]);
  });
});
