import { describe, it, expect } from "vitest";
import { ROLES, isRole, roleAtLeast } from "./rbac";

describe("rbac role hierarchy", () => {
  it("orders roles least → most privileged", () => {
    expect(ROLES).toEqual(["viewer", "member", "admin", "owner"]);
  });

  it("isRole accepts known roles and rejects everything else", () => {
    expect(isRole("owner")).toBe(true);
    expect(isRole("viewer")).toBe(true);
    expect(isRole("superadmin")).toBe(false);
    expect(isRole("")).toBe(false);
    expect(isRole(null)).toBe(false);
    expect(isRole(undefined)).toBe(false);
    expect(isRole(3)).toBe(false);
  });

  it("roleAtLeast is true when actual >= required", () => {
    expect(roleAtLeast("owner", "viewer")).toBe(true);
    expect(roleAtLeast("admin", "member")).toBe(true);
    expect(roleAtLeast("member", "member")).toBe(true);
    expect(roleAtLeast("owner", "owner")).toBe(true);
  });

  it("roleAtLeast is false when actual < required", () => {
    expect(roleAtLeast("viewer", "member")).toBe(false);
    expect(roleAtLeast("member", "admin")).toBe(false);
    expect(roleAtLeast("admin", "owner")).toBe(false);
  });

  it("roleAtLeast rejects unknown/invalid actual roles", () => {
    expect(roleAtLeast("superadmin", "viewer")).toBe(false);
    expect(roleAtLeast(null, "viewer")).toBe(false);
    expect(roleAtLeast(undefined, "viewer")).toBe(false);
    expect(roleAtLeast("", "viewer")).toBe(false);
  });
});
