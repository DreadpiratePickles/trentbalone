import { describe, expect, it } from "vitest";
import { assertActionPermission, hasActionPermission } from "./permissions";

describe("granular action permissions", () => {
  const grants = [
    { subjectId: "agent_growth", companyId: "co_1", action: "marketing.campaign.draft", scope: "company" as const },
    { subjectId: "agent_growth", companyId: "co_1", action: "social.post.publish", scope: "object" as const, objectId: "post_1" },
  ];

  it("allows exact per-action grants and denies by default", () => {
    expect(hasActionPermission({ grants, subjectId: "agent_growth", companyId: "co_1", action: "marketing.campaign.draft" })).toBe(true);
    expect(hasActionPermission({ grants, subjectId: "agent_growth", companyId: "co_1", action: "social.post.publish", objectId: "post_1" })).toBe(true);
    expect(hasActionPermission({ grants, subjectId: "agent_growth", companyId: "co_1", action: "social.post.publish", objectId: "post_2" })).toBe(false);
    expect(hasActionPermission({ grants, subjectId: "agent_growth", companyId: "co_2", action: "marketing.campaign.draft" })).toBe(false);
  });

  it("throws a helpful denial error when a grant is missing", () => {
    expect(() => assertActionPermission({
      grants,
      subjectId: "agent_growth",
      companyId: "co_1",
      action: "billing.refund.create",
    })).toThrow("Missing permission billing.refund.create");
  });
});
