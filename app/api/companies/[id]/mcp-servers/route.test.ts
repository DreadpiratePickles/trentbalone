import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

const { mockGetAuthUser, mockRequireRoleForRequest, mockCreateMcpServer, mockListMcpServers } = vi.hoisted(() => ({
  mockGetAuthUser: vi.fn(),
  mockRequireRoleForRequest: vi.fn(),
  mockCreateMcpServer: vi.fn(),
  mockListMcpServers: vi.fn(),
}));

vi.mock("@/lib/session", () => ({
  getAuthUser: mockGetAuthUser,
  requireRoleForRequest: mockRequireRoleForRequest,
  unauthorized: () => new Response("unauthorized", { status: 401 }),
  forbidden: () => new Response("forbidden", { status: 403 }),
}));

vi.mock("@/lib/mcp-store", () => ({
  createMcpServer: mockCreateMcpServer,
  listMcpServers: mockListMcpServers,
}));

import { POST } from "./route";

describe("/api/companies/[id]/mcp-servers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAuthUser.mockResolvedValue({ id: "user_1" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: true, role: "member" });
    mockListMcpServers.mockResolvedValue([]);
    mockCreateMcpServer.mockImplementation(async (input: Record<string, unknown>) => ({
      id: "mcp_1",
      companyId: input.companyId,
      name: input.name,
      url: input.url,
      transport: input.transport,
      hasCredential: Boolean(input.token),
      toolAllowlist: [],
      reversibleTools: [],
      status: "configured",
      discoveredTools: [],
      enabled: true,
      createdAt: "2026-06-13T00:00:00.000Z",
      updatedAt: "2026-06-13T00:00:00.000Z",
    }));
  });

  it("accepts the allowlisted Sentry stdio preset without downgrading it to HTTP", async () => {
    const res = await POST(jsonRequest({
      name: "Sentry",
      url: "stdio://sentry",
      transport: "stdio",
      token: "sentry-token",
    }), { params: Promise.resolve({ id: "co_1" }) });
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(mockCreateMcpServer).toHaveBeenCalledWith(expect.objectContaining({
      companyId: "co_1",
      name: "Sentry",
      url: "stdio://sentry",
      transport: "stdio",
      token: "sentry-token",
    }));
    expect(body.server.transport).toBe("stdio");
    expect(JSON.stringify(body)).not.toContain("sentry-token");
  });

  it("rejects arbitrary stdio targets before they can become executable transports", async () => {
    const res = await POST(jsonRequest({
      name: "Shell",
      url: "stdio://bash",
      transport: "stdio",
      token: "secret",
    }), { params: Promise.resolve({ id: "co_1" }) });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toMatch(/unsupported stdio MCP preset/i);
    expect(mockCreateMcpServer).not.toHaveBeenCalled();
  });
});

function jsonRequest(body: Record<string, unknown>) {
  return new Request("http://x/api/companies/co_1/mcp-servers", {
    method: "POST",
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}
