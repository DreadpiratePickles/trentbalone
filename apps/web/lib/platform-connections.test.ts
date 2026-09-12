import { describe, expect, it } from "vitest";
import { decryptJson } from "@/lib/secrets";
import { store } from "@/lib/store";
import {
  getMarketingCredentialMap,
  getSocialCredentialMap,
  listPlatformConnectionStatuses,
  saveMarketingPlatformConnection,
  saveSocialPlatformConnection,
} from "@/lib/platform-connections";

describe("platform connections", () => {
  it("stores social credentials encrypted and links the social account to the connection", async () => {
    const company = await store.createCompany({ name: "Social Connect", brief: { vision: "test" } });

    const result = await saveSocialPlatformConnection(company.id, {
      platform: "tiktok",
      accessToken: "tiktok_token_123456789",
      externalAccountId: "acct_tiktok",
      externalHandle: "@trent",
      displayName: "Trent",
      scopes: ["post:write", "dm:read"],
      autoPublishEnabled: true,
    });

    expect(result.connection.provider).toBe("Social:TikTok");
    expect(result.connection.encryptedData).not.toContain("tiktok_token_123456789");
    expect(decryptJson(result.connection.encryptedData ?? "")).toMatchObject({
      platform: "tiktok",
      accessToken: "tiktok_token_123456789",
    });
    expect(result.account).toMatchObject({
      platform: "tiktok",
      credentialsRef: result.connection.id,
      autoPublishEnabled: true,
    });
  });

  it("stores ads credentials encrypted and exposes readiness without leaking tokens", async () => {
    const company = await store.createCompany({ name: "Ads Connect", brief: { vision: "test" } });

    const result = await saveMarketingPlatformConnection(company.id, {
      platform: "meta",
      accessToken: "meta_token_123456789",
      externalAccountId: "act_meta",
      externalBusinessId: "biz_meta",
      currency: "usd",
      dailyBudgetCents: 2500,
      paymentStatus: "ready",
      consentForServerEvents: true,
    });

    expect(result.connection.provider).toBe("Ads:Meta");
    expect(result.connection.encryptedData).not.toContain("meta_token_123456789");
    expect(result.account).toMatchObject({
      platform: "meta",
      paymentStatus: "ready",
      dailyBudgetCents: 2500,
    });
    await expect(getMarketingCredentialMap(company.id)).resolves.toMatchObject({ meta: true });

    const statuses = await listPlatformConnectionStatuses(company.id);
    expect(JSON.stringify(statuses)).not.toContain("meta_token_123456789");
    expect(statuses.marketing).toEqual(expect.arrayContaining([
      expect.objectContaining({ platform: "meta", provider: "Ads:Meta", status: "connected", source: "company" }),
    ]));
  });

  it("treats missing or unhealthy platform integrations as unusable credentials", async () => {
    const company = await store.createCompany({ name: "Credential Health", brief: { vision: "test" } });
    await store.upsertIntegration({
      companyId: company.id,
      provider: "Social:Instagram",
      scopes: ["post:write"],
      status: "needs_credentials",
      encryptedData: "encrypted",
    });
    await store.upsertIntegration({
      companyId: company.id,
      provider: "Ads:Meta",
      scopes: ["ads:read"],
      status: "connected",
      encryptedData: "encrypted",
    });

    await expect(getSocialCredentialMap(company.id)).resolves.toMatchObject({ instagram: false });
    await expect(getMarketingCredentialMap(company.id)).resolves.toMatchObject({ meta: false });
  });
});
