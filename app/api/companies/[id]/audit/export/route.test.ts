import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockGetAuthUser, mockRequireRole, mockForbidden, mockUnauthorized } = vi.hoisted(() => ({
  mockGetAuthUser: vi.fn(),
  mockRequireRole: vi.fn(),
  mockForbidden: vi.fn(() => new Response("f", { status: 403 })),
  mockUnauthorized: vi.fn(() => new Response("u", { status: 401 })),
}));

vi.mock("@/lib/session", () => ({
  getAuthUser: mockGetAuthUser,
  requireRole: mockRequireRole,
  forbidden: mockForbidden,
  unauthorized: mockUnauthorized,
}));

const { mockListAuditLogs } = vi.hoisted(() => ({
  mockListAuditLogs: vi.fn(),
}));

vi.mock("@/lib/store", () => ({
  store: { listAuditLogs: mockListAuditLogs },
}));

import { GET } from "./route";

describe("GET /api/companies/[id]/audit/export", () => {
  const params = Promise.resolve({ id: "co1" });

  beforeEach(() => {
    mockGetAuthUser.mockReset();
    mockRequireRole.mockReset();
    mockForbidden.mockReturnValue(new Response("f", { status: 403 }));
    mockUnauthorized.mockReturnValue(new Response("u", { status: 401 }));
  });

  it("returns 401 when unauthenticated", async () => {
    mockGetAuthUser.mockResolvedValue(null);
    const res = await GET(new Request("http://x/api/companies/co1/audit/export"), { params });
    expect(res.status).toBe(401);
  });

  it("returns 403 when user lacks admin role", async () => {
    mockGetAuthUser.mockResolvedValue({ id: "u1" });
    mockRequireRole.mockResolvedValue({ ok: false });
    const res = await GET(new Request("http://x/api/companies/co1/audit/export"), { params });
    expect(res.status).toBe(403);
    expect(mockRequireRole).toHaveBeenCalledWith("u1", "co1", "admin");
  });

  it("returns 200 with NDJSON content-type and attachment header", async () => {
    mockGetAuthUser.mockResolvedValue({ id: "u1" });
    mockRequireRole.mockResolvedValue({ ok: true, role: "admin" });
    mockListAuditLogs.mockResolvedValue([
      { id: "a1", companyId: "co1", actor: "user", action: "task.create", objectType: "task",
        objectId: "t1", summary: "Created task", hash: "abc", prevHash: "genesis", createdAt: "2026-01-01T00:00:00.000Z" },
    ]);
    const res = await GET(new Request("http://x/api/companies/co1/audit/export"), { params });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/x-ndjson");
    expect(res.headers.get("content-disposition")).toContain("attachment");
    expect(res.headers.get("content-disposition")).toContain("audit-co1-");
  });

  it("returns valid NDJSON — each line is a parseable JSON object", async () => {
    mockGetAuthUser.mockResolvedValue({ id: "u1" });
    mockRequireRole.mockResolvedValue({ ok: true, role: "admin" });
    mockListAuditLogs.mockResolvedValue([
      { id: "a1", companyId: "co1", actor: "user", action: "task.create", objectType: "task",
        objectId: "t1", summary: "Created task", hash: "abc", prevHash: "genesis", createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "a2", companyId: "co1", actor: "agent", action: "task.complete", objectType: "task",
        objectId: "t1", summary: "Task done", hash: "def", prevHash: "abc", createdAt: "2026-01-02T00:00:00.000Z" },
    ]);
    const res = await GET(new Request("http://x/api/companies/co1/audit/export"), { params });
    const text = await res.text();
    const lines = text.trim().split("\n");
    expect(lines).toHaveLength(2);
    const parsed = lines.map((l) => JSON.parse(l) as { id: string });
    // oldest first
    expect(parsed[0].id).toBe("a2");
    expect(parsed[1].id).toBe("a1");
  });
});
