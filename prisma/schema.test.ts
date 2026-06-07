// prisma/schema.test.ts
import { describe, it, expect } from "vitest";
import { CompanyMemberRole } from "@prisma/client";

describe("Prisma enum definition", () => {
  it("defines the expected CompanyMemberRole enum values", () => {
    expect(CompanyMemberRole).toBeDefined();
    expect(CompanyMemberRole.viewer).toBe("viewer");
    expect(CompanyMemberRole.member).toBe("member");
    expect(CompanyMemberRole.admin).toBe("admin");
    expect(CompanyMemberRole.owner).toBe("owner");
  });
});
