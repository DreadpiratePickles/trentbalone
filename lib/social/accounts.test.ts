import { describe, expect, it } from "vitest";
import { memStore } from "@/lib/mem-store";
import {
  SOCIAL_PLATFORMS,
  normalizeSocialAccountInput,
  normalizeSocialPlatform,
  upsertSocialAccountForCompany,
} from "./accounts";

describe("social/accounts", () => {
  it("supports all expected social platforms", () => {
    expect(SOCIAL_PLATFORMS).toEqual([
      "x",
      "instagram",
      "facebook",
      "linkedin",
      "tiktok",
      "youtube",
      "threads",
      "bluesky",
      "mastodon",
    ]);

    for (const platform of SOCIAL_PLATFORMS) {
      expect(normalizeSocialPlatform(platform.toUpperCase())).toBe(platform);
    }
  });

  it("normalizes input and defaults autoPublishEnabled to false", () => {
    const normalized = normalizeSocialAccountInput({
      companyId: "co_1",
      platform: "X",
      externalAccountId: "acct_1",
      externalHandle: " @trent ",
      displayName: " Trent ",
      scopes: ["read", "write"],
    });

    expect(normalized).toEqual({
      companyId: "co_1",
      platform: "x",
      externalAccountId: "acct_1",
      externalHandle: "@trent",
      displayName: "Trent",
      scopes: ["read", "write"],
      autoPublishEnabled: false,
    });
  });

  it("upsert is idempotent by companyId+platform+externalAccountId", async () => {
    const companyId = `co_social_accounts_${Date.now()}`;
    const first = await upsertSocialAccountForCompany(memStore, {
      companyId,
      platform: "x",
      externalAccountId: "acct_1",
      externalHandle: "@trent",
      displayName: "Trent",
      scopes: ["post:write"],
    });

    const second = await upsertSocialAccountForCompany(memStore, {
      companyId,
      platform: "x",
      externalAccountId: "acct_1",
      externalHandle: "@trent_ai",
      displayName: "Trent AI",
      scopes: ["post:write", "dm:read"],
      autoPublishEnabled: true,
    });

    expect(second.id).toBe(first.id);
    await expect(memStore.listSocialAccounts(companyId)).resolves.toHaveLength(1);
    expect(second.externalHandle).toBe("@trent_ai");
    expect(second.autoPublishEnabled).toBe(true);
  });
});
