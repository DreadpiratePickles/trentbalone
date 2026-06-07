import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockGetAuthUser, mockRequireRoleForRequest } = vi.hoisted(() => ({
  mockGetAuthUser: vi.fn(),
  mockRequireRoleForRequest: vi.fn(),
}));

vi.mock("@/lib/session", () => ({
  getAuthUser: mockGetAuthUser,
  requireRoleForRequest: mockRequireRoleForRequest,
  unauthorized: () => new Response("u", { status: 401 }),
  forbidden: () => new Response("f", { status: 403 }),
}));

vi.mock("@/lib/store", () => ({
  store: {
    listAgents: vi.fn().mockResolvedValue([]),
    listAgentPlugAssignments: vi.fn().mockResolvedValue([]),
    listAgentEntitlements: vi.fn().mockResolvedValue([]),
    clearAgentPlugAssignment: vi.fn().mockResolvedValue(undefined),
    updateAgent: vi.fn().mockResolvedValue({ id: "ag1" }),
    upsertAgentPlugAssignment: vi.fn().mockResolvedValue({ id: "asgn1", environment: { memoryNamespace: "ns1", tools: [] } }),
  },
}));

vi.mock("@/lib/agent-catalog", () => ({
  AGENT_CATALOG: [],
  AGENT_SLOTS: [{ role: "ceo" }, { role: "engineer" }],
  SLOT_CONTRACTS: {},
  buildSlotEnvironment: vi.fn().mockReturnValue({}),
  getCatalogAgent: vi.fn().mockReturnValue(null),
}));

vi.mock("@/lib/agent-marketplace", () => ({
  catalogWithAccess: vi.fn().mockResolvedValue([]),
  findAgentProductForProfile: vi.fn().mockReturnValue(null),
  hasProfileEntitlement: vi.fn().mockReturnValue(false),
  packProductId: vi.fn().mockReturnValue("pack1"),
}));

vi.mock("@/lib/agent-runtime", () => ({
  getAgentRuntime: vi.fn().mockResolvedValue({ profile: null, environment: {} }),
}));

import { GET, PATCH } from "./route";

describe("/api/agent-plug RBAC", () => {
  beforeEach(() => {
    mockGetAuthUser.mockReset();
    mockRequireRoleForRequest.mockReset();
  });

  it("GET: returns 200 without auth check when companyId is absent (open catalog)", async () => {
    mockGetAuthUser.mockResolvedValue({ id: "u1" });
    const res = await GET(new Request("http://x/api/agent-plug"));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      readiness: {
        catalog: { totalProfiles: 0 },
        slots: { totalSlots: 2 },
        ready: false,
      },
    });
    expect(mockRequireRoleForRequest).not.toHaveBeenCalled();
  });

  it("GET: returns 403 when companyId is present and user lacks viewer role", async () => {
    mockGetAuthUser.mockResolvedValue({ id: "u1" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: false });
    const res = await GET(new Request("http://x/api/agent-plug?companyId=c1"));
    expect(res.status).toBe(403);
    expect(mockRequireRoleForRequest).toHaveBeenCalledWith("u1", "viewer", { companyId: "c1" });
  });

  it("PATCH: returns 403 when user lacks admin role", async () => {
    mockGetAuthUser.mockResolvedValue({ id: "u1" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: false });
    const res = await PATCH(new Request("http://x/api/agent-plug", {
      method: "PATCH",
      body: JSON.stringify({ companyId: "c1", role: "ceo", catalogAgentId: null }),
    }));
    expect(res.status).toBe(403);
    expect(mockRequireRoleForRequest).toHaveBeenCalledWith("u1", "admin", { companyId: "c1" });
  });
});
