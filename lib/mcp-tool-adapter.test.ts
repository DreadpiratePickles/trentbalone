import { describe, expect, it } from "vitest";
import { createMcpToolAdapter } from "@/lib/mcp-tool-adapter";
import type { McpServerRecord } from "@/lib/mcp-store";

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
});
