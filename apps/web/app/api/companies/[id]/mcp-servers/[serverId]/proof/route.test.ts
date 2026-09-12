import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

const {
  mockAppendAuditLog,
  mockDiscoverMcpTools,
  mockGetAuthUser,
  mockGetMcpServer,
  mockRequireRoleForRequest,
  mockUpdateMcpServer,
} = vi.hoisted(() => ({
  mockAppendAuditLog: vi.fn(),
  mockDiscoverMcpTools: vi.fn(),
  mockGetAuthUser: vi.fn(),
  mockGetMcpServer: vi.fn(),
  mockRequireRoleForRequest: vi.fn(),
  mockUpdateMcpServer: vi.fn(),
}));

vi.mock("@/lib/audit-log", () => ({ appendAuditLog: mockAppendAuditLog }));
vi.mock("@/lib/mcp-tool-adapter", () => ({ discoverMcpTools: mockDiscoverMcpTools }));
vi.mock("@/lib/mcp-store", () => ({
  getMcpServer: mockGetMcpServer,
  updateMcpServer: mockUpdateMcpServer,
}));
vi.mock("@/lib/session", () => ({
  getAuthUser: mockGetAuthUser,
  requireRoleForRequest: mockRequireRoleForRequest,
  unauthorized: () => new Response("unauthorized", { status: 401 }),
  forbidden: () => new Response("forbidden", { status: 403 }),
}));

import { POST } from "./route";

describe("/api/companies/[id]/mcp-servers/[serverId]/proof", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAuthUser.mockResolvedValue({ id: "user_1" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: true, role: "member" });
    mockAppendAuditLog.mockResolvedValue(undefined);
    mockGetMcpServer.mockResolvedValue(server());
    mockUpdateMcpServer.mockImplementation(async (_companyId: string, _serverId: string, patch: Record<string, unknown>) => ({
      ...server(),
      ...patch,
    }));
  });

  it("runs a read proof by discovering tools and writing an audit row", async () => {
    mockDiscoverMcpTools.mockResolvedValue([{ name: "search", description: "Search docs" }]);
    const res = await POST(jsonRequest({ action: "test_read" }), {
      params: Promise.resolve({ id: "co_1", serverId: "mcp_1" }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.proof.status).toBe("passed");
    expect(body.proof.toolCount).toBe(1);
    expect(mockUpdateMcpServer).toHaveBeenCalledWith("co_1", "mcp_1", expect.objectContaining({ status: "connected" }));
    expect(mockAppendAuditLog).toHaveBeenCalledWith("co_1", "user", "mcp.proof.test_read", "mcp_server", "mcp_1", expect.stringContaining("discovery returned 1"));
  });

  it("classifies write proof as a dry-run without remote discovery", async () => {
    const res = await POST(jsonRequest({ action: "test_write_dry_run", toolName: "stripe_refund" }), {
      params: Promise.resolve({ id: "co_1", serverId: "mcp_1" }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.proof.dryRun).toBe(true);
    expect(body.proof.risk).toBe("critical");
    expect(mockDiscoverMcpTools).not.toHaveBeenCalled();
    expect(mockAppendAuditLog).toHaveBeenCalledWith("co_1", "user", "mcp.proof.write_dry_run", "mcp_server", "mcp_1", expect.stringContaining("no remote tool call executed"));
  });
});

function jsonRequest(body: Record<string, unknown>) {
  return new Request("http://x/api/companies/co_1/mcp-servers/mcp_1/proof", {
    method: "POST",
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

function server() {
  return {
    id: "mcp_1",
    companyId: "co_1",
    name: "Stripe",
    url: "https://mcp.stripe.com",
    transport: "http",
    hasCredential: true,
    toolAllowlist: [],
    reversibleTools: [],
    approvalPolicies: {},
    status: "connected",
    discoveredTools: [
      {
        name: "stripe_refund",
        description: "Create a customer refund",
        annotations: { destructiveHint: true },
      },
    ],
    enabled: true,
    createdAt: "2026-06-18T00:00:00.000Z",
    updatedAt: "2026-06-18T00:00:00.000Z",
  };
}
