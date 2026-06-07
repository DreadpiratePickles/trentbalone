import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockGetMemberRole, mockGetTask, mockGetArtifact, mockGetRecurringTask } = vi.hoisted(() => ({
  mockGetMemberRole: vi.fn(),
  mockGetTask: vi.fn(),
  mockGetArtifact: vi.fn(),
  mockGetRecurringTask: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  auth: vi.fn()
}));

vi.mock("./store", () => ({
  store: {
    getMemberRole: mockGetMemberRole,
    getTask: mockGetTask,
    getArtifact: mockGetArtifact,
    getRecurringTask: mockGetRecurringTask,
  }
}));

import { requireRole, requireRoleForRequest } from "./session";

describe("requireRole", () => {
  beforeEach(() => mockGetMemberRole.mockReset());

  it("allows when member role meets the minimum", async () => {
    mockGetMemberRole.mockResolvedValue("admin");
    const res = await requireRole("u1", "c1", "member");
    expect(res.ok).toBe(true);
  });

  it("denies when role is below the minimum", async () => {
    mockGetMemberRole.mockResolvedValue("viewer");
    const res = await requireRole("u1", "c1", "member");
    expect(res.ok).toBe(false);
  });

  it("denies when user is not a member (null role)", async () => {
    mockGetMemberRole.mockResolvedValue(null);
    const res = await requireRole("u1", "c1", "viewer");
    expect(res.ok).toBe(false);
  });
});

describe("requireRoleForRequest", () => {
  beforeEach(() => {
    mockGetMemberRole.mockReset();
    mockGetTask.mockReset();
    mockGetArtifact.mockReset();
    mockGetRecurringTask.mockReset();
  });

  it("handles companyId target directly", async () => {
    mockGetMemberRole.mockResolvedValue("viewer");
    const res = await requireRoleForRequest("u1", "viewer", { companyId: "c1" });
    expect(res).toEqual({ ok: true, role: "viewer", companyId: "c1" });
  });

  it("resolves companyId from task target", async () => {
    mockGetTask.mockResolvedValue({ id: "t1", companyId: "c1" });
    mockGetMemberRole.mockResolvedValue("member");
    const res = await requireRoleForRequest("u1", "member", { entityType: "task", entityId: "t1" });
    expect(res).toEqual({ ok: true, role: "member", companyId: "c1" });
    expect(mockGetTask).toHaveBeenCalledWith("t1");
  });

  it("resolves companyId from artifact target", async () => {
    mockGetArtifact.mockResolvedValue({ id: "a1", companyId: "c1" });
    mockGetMemberRole.mockResolvedValue("viewer");
    const res = await requireRoleForRequest("u1", "viewer", { entityType: "artifact", entityId: "a1" });
    expect(res).toEqual({ ok: true, role: "viewer", companyId: "c1" });
    expect(mockGetArtifact).toHaveBeenCalledWith("a1");
  });

  it("resolves companyId from recurring task target", async () => {
    mockGetRecurringTask.mockResolvedValue({ id: "rt1", companyId: "c1" });
    mockGetMemberRole.mockResolvedValue("member");
    const res = await requireRoleForRequest("u1", "member", { entityType: "recurring-task", entityId: "rt1" });
    expect(res).toEqual({ ok: true, role: "member", companyId: "c1" });
    expect(mockGetRecurringTask).toHaveBeenCalledWith("rt1");
  });

  it("returns no_membership if entity is not found", async () => {
    mockGetTask.mockResolvedValue(null);
    const res = await requireRoleForRequest("u1", "viewer", { entityType: "task", entityId: "t1" });
    expect(res).toEqual({ ok: false, reason: "no_membership" });
  });
});

