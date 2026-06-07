import { describe, expect, it } from "vitest";
import { detectSuspiciousImpersonators } from "./anti-impersonation";

describe("social anti-impersonation", () => {
  it("flags lookalike handles, copied display names, and brand-link bios", () => {
    const result = detectSuspiciousImpersonators({
      ownedHandles: ["@trent"],
      brandNames: ["Trent"],
      brandDomains: ["trent.ai"],
      candidates: [
        {
          platform: "x",
          externalContactId: "fake_1",
          handle: "@trcnt",
          displayName: "Trent Support",
          bio: "Official support for trent.ai customers",
          profileUrl: "https://x.example/trcnt",
          followerCount: 12,
          verified: false,
        },
        {
          platform: "x",
          externalContactId: "real_1",
          handle: "@happycustomer",
          displayName: "Happy Customer",
          bio: "Building with AI",
          profileUrl: "https://x.example/happycustomer",
          followerCount: 500,
          verified: false,
        },
      ],
    });

    expect(result.suspicious).toHaveLength(1);
    expect(result.suspicious[0]).toMatchObject({
      externalContactId: "fake_1",
      platform: "x",
      severity: "high",
    });
    expect(result.suspicious[0]?.reasons).toEqual(expect.arrayContaining([
      "lookalike_handle",
      "brand_display_name",
      "brand_domain_in_bio",
    ]));
    expect(result.reviewed).toBe(2);
  });

  it("does not flag owned handles or low-similarity profiles", () => {
    const result = detectSuspiciousImpersonators({
      ownedHandles: ["@trent"],
      brandNames: ["Trent"],
      brandDomains: ["trent.ai"],
      candidates: [
        { platform: "linkedin", externalContactId: "owned", handle: "@trent", displayName: "Trent", verified: true },
        { platform: "linkedin", externalContactId: "other", handle: "@operatoros", displayName: "Operator OS" },
      ],
    });

    expect(result.suspicious).toEqual([]);
  });
});
