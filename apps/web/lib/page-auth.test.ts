import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetAuthUser, mockRequireRoleForRequest, mockRedirect, mockNotFound } = vi.hoisted(() => ({
  mockGetAuthUser: vi.fn(),
  mockRequireRoleForRequest: vi.fn(),
  mockRedirect: vi.fn((url: string) => {
    throw new Error(`redirect:${url}`);
  }),
  mockNotFound: vi.fn(() => {
    throw new Error("notFound");
  }),
}));

vi.mock("next/navigation", () => ({
  redirect: mockRedirect,
  notFound: mockNotFound,
}));

vi.mock("@/lib/session", () => ({
  getAuthUser: mockGetAuthUser,
  requireRoleForRequest: mockRequireRoleForRequest,
}));

import { requireCompanyPageAccess } from "./page-auth";

describe("requireCompanyPageAccess", () => {
  beforeEach(() => {
    mockGetAuthUser.mockReset();
    mockRequireRoleForRequest.mockReset();
    mockRedirect.mockClear();
    mockNotFound.mockClear();
  });

  it("redirects unauthenticated users before server-side company data is loaded", async () => {
    mockGetAuthUser.mockResolvedValue(null);

    await expect(requireCompanyPageAccess("co_1")).rejects.toThrow(
      "redirect:/auth/signin?callbackUrl=%2Fcompanies%2Fco_1"
    );
    expect(mockRequireRoleForRequest).not.toHaveBeenCalled();
  });

  it("fails closed when the user lacks company membership", async () => {
    mockGetAuthUser.mockResolvedValue({ id: "user_1", email: "u@example.com" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: false, reason: "no_membership" });

    await expect(requireCompanyPageAccess("co_1")).rejects.toThrow("notFound");
    expect(mockRequireRoleForRequest).toHaveBeenCalledWith("user_1", "viewer", { companyId: "co_1" });
  });

  it("returns the authenticated user and role when access is allowed", async () => {
    mockGetAuthUser.mockResolvedValue({ id: "user_1", email: "u@example.com" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: true, role: "admin", companyId: "co_1" });

    await expect(requireCompanyPageAccess("co_1", "member")).resolves.toEqual({
      user: { id: "user_1", email: "u@example.com" },
      role: "admin",
      companyId: "co_1",
    });
  });
});
