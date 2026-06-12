import { describe, expect, it, vi } from "vitest";
import { createMcpToolAdapter, discoverMcpTools } from "@/lib/mcp-tool-adapter";
import type { McpServerRecord } from "@/lib/mcp-store";

vi.mock("@/lib/mcp-store", () => ({
  getMcpServerToken: vi.fn(async () => {
    throw new Error("token store should not be queried for unauthenticated MCP servers");
  }),
  listEnabledMcpServers: vi.fn(async () => []),
}));

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: vi.fn().mockImplementation(() => ({
    connect: vi.fn(),
    close: vi.fn(async () => undefined),
    listTools: vi.fn(async () => ({
      tools: [{ name: "search", description: "Search docs" }],
    })),
    callTool: vi.fn(async () => ({
      content: [{ type: "text", text: "search ok" }],
    })),
  })),
}));

function server(overrides: Partial<McpServerRecord> = {}): McpServerRecord {
  return {
    id: "mcp_1",
    companyId: "co_1",
    name: "Docs Server",
    url: "https://mcp.example.com",
    transport: "http",
    hasCredential: true,
    toolAllowlist: ["search"],
    reversibleTools: [],
    status: "connected",
    discoveredTools: [{ name: "search", description: "Search docs" }],
    enabled: true,
    createdAt: "2026-06-12T00:00:00.000Z",
    updatedAt: "2026-06-12T00:00:00.000Z",
    ...overrides,
  };
}

describe("createMcpToolAdapter", () => {
  it("declares dynamic MCP adapter availability and keeps tools approval-required by default", () => {
    const adapter = createMcpToolAdapter(server());

    expect(adapter.availability).toBe("real");
    expect(adapter.requiresApproval("search")).toBe(true);
  });

  it("marks disabled or disconnected MCP servers unavailable", () => {
    expect(createMcpToolAdapter(server({ enabled: false })).availability).toBe("unavailable");
    expect(createMcpToolAdapter(server({ status: "failed" })).availability).toBe("unavailable");
  });

  it("discovers and calls an unauthenticated MCP server without querying the token store", async () => {
    const record = server({ hasCredential: false });

    await expect(discoverMcpTools(record)).resolves.toEqual([{ name: "search", description: "Search docs" }]);
    await expect(createMcpToolAdapter(record).execute("search", {})).resolves.toMatchObject({
      adapter: "mcp_docs_server",
      action: "search",
      status: "completed",
      summary: expect.stringContaining("search ok"),
    });
  });
});
