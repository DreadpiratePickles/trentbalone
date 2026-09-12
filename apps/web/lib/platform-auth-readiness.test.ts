import { describe, expect, it } from "vitest";
import { buildPlatformAuthReadiness, inferPlatformRequirements } from "@/lib/platform-auth-readiness";
import type { MarketingAccount, SocialAccount } from "@/lib/types";

describe("buildPlatformAuthReadiness", () => {
  it("blocks publishing when required social accounts are missing credentials, scopes, or auto-publish", () => {
    const result = buildPlatformAuthReadiness({
      requiredSocialPlatforms: ["x", "tiktok"],
      socialAccounts: [
        socialAccount({ platform: "x", scopes: ["post:write"], credentialsRef: "conn_x", autoPublishEnabled: false }),
      ],
    });

    expect(result.ready).toBe(false);
    expect(result.blockers).toEqual(expect.arrayContaining([
      "x auto-publish is disabled",
      "tiktok social account is not connected",
    ]));
    expect(result.approvalRequired).toBe(true);
  });

  it("allows draft-only social work when accounts are connected but external action stays approval-gated", () => {
    const result = buildPlatformAuthReadiness({
      requiredSocialPlatforms: ["x"],
      socialAccounts: [
        socialAccount({ platform: "x", scopes: ["post:write"], credentialsRef: "conn_x", autoPublishEnabled: true }),
      ],
    });

    expect(result.ready).toBe(true);
    expect(result.instructions).toContain("Publishing remains approval-gated");
  });

  it("blocks social publishing when the account exists but the credential integration is not connected", () => {
    const result = buildPlatformAuthReadiness({
      requiredSocialPlatforms: ["instagram"],
      socialAccounts: [
        socialAccount({
          platform: "instagram",
          scopes: ["post:write"],
          credentialsRef: "conn_instagram",
          autoPublishEnabled: true,
        }),
      ],
      socialCredentials: { instagram: false },
    });

    expect(result.ready).toBe(false);
    expect(result.blockers).toContain("instagram social credentials are missing");
  });

  it("blocks paid ads when the marketing account is missing payment readiness or budget", () => {
    const result = buildPlatformAuthReadiness({
      requiredMarketingPlatforms: ["meta", "linkedin"],
      marketingAccounts: [
        marketingAccount({ platform: "meta", status: "active", paymentStatus: "needs_payment_method", dailyBudgetCents: 0 }),
      ],
      marketingCredentials: { meta: true },
    });

    expect(result.ready).toBe(false);
    expect(result.blockers).toEqual(expect.arrayContaining([
      "meta payment status is needs_payment_method",
      "meta daily budget is not configured",
      "linkedin marketing account is not connected",
    ]));
  });

  it("blocks paid ads when the marketing account has no connected ads credential", () => {
    const result = buildPlatformAuthReadiness({
      requiredMarketingPlatforms: ["meta"],
      marketingAccounts: [
        marketingAccount({ platform: "meta", status: "active", paymentStatus: "ready", dailyBudgetCents: 2500 }),
      ],
      marketingCredentials: {},
    });

    expect(result.ready).toBe(false);
    expect(result.blockers).toContain("meta ads credentials are missing");
  });

  it("infers platform requirements from social and paid mission text", () => {
    const result = inferPlatformRequirements("Publish on TikTok, X, LinkedIn, then run Meta and Google ads.");

    expect(result.requiredSocialPlatforms).toEqual(["tiktok", "x", "linkedin"]);
    expect(result.requiredMarketingPlatforms).toEqual(["meta", "google"]);
    expect(result.socialPublishingRequested).toBe(true);
    expect(result.paidAdsRequested).toBe(true);
  });

  it("infers creative app requirements and blocks generation when credentials are missing", () => {
    const inferred = inferPlatformRequirements("Create Higgsfield launch videos, publish them on TikTok, and run Meta ads.");
    const result = buildPlatformAuthReadiness({
      ...inferred,
      socialAccounts: [],
      marketingAccounts: [],
      creativeCredentials: {},
    });

    expect(inferred.requiredCreativeApps).toEqual(["higgsfield"]);
    expect(inferred.creativeGenerationRequested).toBe(true);
    expect(result.ready).toBe(false);
    expect(result.blockers).toEqual(expect.arrayContaining([
      "higgsfield creative credentials are missing",
      "tiktok social account is not connected",
      "meta marketing account is not connected",
    ]));
  });
});

function socialAccount(overrides: Partial<SocialAccount>): SocialAccount {
  return {
    id: "social_1",
    companyId: "co_1",
    platform: "x",
    status: "active",
    externalAccountId: "acct_1",
    scopes: [],
    autoPublishEnabled: false,
    createdAt: "2026-06-04T00:00:00.000Z",
    updatedAt: "2026-06-04T00:00:00.000Z",
    ...overrides,
  };
}

function marketingAccount(overrides: Partial<MarketingAccount>): MarketingAccount {
  return {
    id: "marketing_1",
    companyId: "co_1",
    platform: "meta",
    status: "active",
    externalAccountId: "act_1",
    externalBusinessId: "biz_1",
    currency: "USD",
    dailyBudgetCents: 1000,
    paymentStatus: "ready",
    consentForServerEvents: true,
    createdAt: "2026-06-04T00:00:00.000Z",
    updatedAt: "2026-06-04T00:00:00.000Z",
    ...overrides,
  };
}
