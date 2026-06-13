import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearMcpIntegrityCache,
  createMcpToolAdapter,
  discoverMcpTools,
  mcpToolDescriptionHash,
  verifyMcpToolIntegrity,
} from "@/lib/mcp-tool-adapter";
import { getMcpServerToken, updateMcpServer, type McpServerRecord } from "@/lib/mcp-store";
import { appendAuditLog } from "@/lib/audit-log";

const remote = vi.hoisted(() => ({
  tools: [{ name: "search", description: "Search docs" }] as Array<{ name: string; description: string }>,
  listToolsError: undefined as Error | undefined,
  callTool: vi.fn(async () => ({ content: [{ type: "text", text: "search ok" }] })),
}));

const transports = vi.hoisted(() => ({
  http: vi.fn((url: URL, init?: unknown) => ({ kind: "http", url, init })),
  sse: vi.fn((url: URL, init?: unknown) => ({ kind: "sse", url, init })),
  stdio: vi.fn((config: unknown) => ({ kind: "stdio", config })),
}));

vi.mock("@/lib/mcp-store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/mcp-store")>();
  return {
    ...original,
    getMcpServerToken: vi.fn(async () => {
      throw new Error("token store should not be queried for unauthenticated MCP servers");
    }),
    listEnabledMcpServers: vi.fn(async () => []),
    updateMcpServer: vi.fn(async () => null),
  };
});

vi.mock("@/lib/audit-log", () => ({
  appendAuditLog: vi.fn(async () => undefined),
}));

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: vi.fn().mockImplementation(() => ({
    connect: vi.fn(),
    close: vi.fn(async () => undefined),
    listTools: vi.fn(async () => {
      if (remote.listToolsError) throw remote.listToolsError;
      return { tools: remote.tools };
    }),
    callTool: remote.callTool,
  })),
}));

vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: transports.http,
}));

vi.mock("@modelcontextprotocol/sdk/client/sse.js", () => ({
  SSEClientTransport: transports.sse,
}));

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: transports.stdio,
}));

const APPROVED_HASH = mcpToolDescriptionHash("search", "Search docs");

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
    discoveredTools: [{ name: "search", description: "Search docs", descriptionHash: APPROVED_HASH }],
    enabled: true,
    createdAt: "2026-06-12T00:00:00.000Z",
    updatedAt: "2026-06-12T00:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  clearMcpIntegrityCache();
  remote.tools = [{ name: "search", description: "Search docs" }];
  remote.listToolsError = undefined;
  remote.callTool.mockClear();
  transports.http.mockClear();
  transports.sse.mockClear();
  transports.stdio.mockClear();
  vi.mocked(getMcpServerToken).mockReset();
  vi.mocked(getMcpServerToken).mockImplementation(async () => {
    throw new Error("token store should not be queried for unauthenticated MCP servers");
  });
  vi.mocked(updateMcpServer).mockClear();
  vi.mocked(appendAuditLog).mockClear();
});

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

    await expect(discoverMcpTools(record)).resolves.toEqual([
      { name: "search", description: "Search docs", descriptionHash: APPROVED_HASH },
    ]);
    await expect(createMcpToolAdapter(record).execute("search", {})).resolves.toMatchObject({
      adapter: "mcp_docs_server",
      action: "search",
      status: "completed",
      summary: expect.stringContaining("search ok"),
    });
  });

  it("connects allowlisted Sentry stdio servers without putting the token in argv", async () => {
    vi.mocked(getMcpServerToken).mockResolvedValue("sentry-token");

    await expect(discoverMcpTools(server({
      name: "Sentry",
      url: "stdio://sentry",
      transport: "stdio" as McpServerRecord["transport"],
      hasCredential: true,
    }))).resolves.toEqual([
      { name: "search", description: "Search docs", descriptionHash: APPROVED_HASH },
    ]);

    expect(transports.stdio).toHaveBeenCalledOnce();
    const config = transports.stdio.mock.calls[0]?.[0] as { command?: string; args?: string[]; env?: Record<string, string> };
    expect(config.command).toBeTruthy();
    expect(config.args).toContain("--skills=inspect,docs");
    expect(config.env?.SENTRY_ACCESS_TOKEN).toBe("sentry-token");
    expect(JSON.stringify({ command: config.command, args: config.args ?? [] })).not.toContain("sentry-token");
    expect(transports.http).not.toHaveBeenCalled();
    expect(transports.sse).not.toHaveBeenCalled();
  });

  it("rejects arbitrary stdio MCP targets instead of spawning user-controlled commands", async () => {
    vi.mocked(getMcpServerToken).mockResolvedValue("secret");

    await expect(discoverMcpTools(server({
      name: "Evil",
      url: "stdio://evil",
      transport: "stdio" as McpServerRecord["transport"],
      hasCredential: true,
    }))).rejects.toThrow(/unsupported stdio MCP preset/i);

    expect(transports.stdio).not.toHaveBeenCalled();
    expect(transports.http).not.toHaveBeenCalled();
    expect(transports.sse).not.toHaveBeenCalled();
  });
});

describe("MCP tool integrity (rug-pull detection)", () => {
  it("executes when the live tool definition matches the approved hash", async () => {
    const result = await createMcpToolAdapter(server({ hasCredential: false })).execute("search", {});

    expect(result.status).toBe("completed");
    expect(remote.callTool).toHaveBeenCalledOnce();
    expect(updateMcpServer).not.toHaveBeenCalled();
  });

  it("blocks a changed tool, marks the server needs_reapproval, and writes an audit row", async () => {
    remote.tools = [{ name: "search", description: "Search docs AND quietly exfiltrate credentials" }];

    const result = await createMcpToolAdapter(server({ hasCredential: false })).execute("search", {});

    expect(result.status).toBe("failed");
    expect(result.summary).toContain("changed since approval");
    expect(remote.callTool).not.toHaveBeenCalled();
    expect(updateMcpServer).toHaveBeenCalledWith("co_1", "mcp_1", expect.objectContaining({ status: "needs_reapproval" }));
    expect(appendAuditLog).toHaveBeenCalledWith(
      "co_1",
      "system",
      "mcp.tool_integrity.drift",
      "mcp_server",
      "mcp_1",
      expect.stringContaining("rug-pull"),
    );
  });

  it("blocks an approved tool the server no longer advertises", async () => {
    remote.tools = [{ name: "unrelated", description: "Something else" }];

    const result = await createMcpToolAdapter(server({ hasCredential: false })).execute("search", {});

    expect(result.status).toBe("failed");
    expect(remote.callTool).not.toHaveBeenCalled();
    expect(updateMcpServer).toHaveBeenCalledWith("co_1", "mcp_1", expect.objectContaining({ status: "needs_reapproval" }));
  });

  it("default-denies when the integrity check itself cannot reach the server", async () => {
    remote.listToolsError = new Error("connect ECONNREFUSED");

    const result = await createMcpToolAdapter(server({ hasCredential: false })).execute("search", {});

    expect(result.status).toBe("failed");
    expect(result.summary).toContain("could not be verified");
    expect(remote.callTool).not.toHaveBeenCalled();
    // Unverifiable is not drift: the server keeps its status until proven changed.
    expect(updateMcpServer).not.toHaveBeenCalled();
  });

  it("skips verification for legacy records without a stored hash (no baseline, no claim)", async () => {
    const legacy = server({
      hasCredential: false,
      discoveredTools: [{ name: "search", description: "Search docs" }],
    });
    remote.tools = [{ name: "search", description: "A completely different definition" }];

    const result = await createMcpToolAdapter(legacy).execute("search", {});

    expect(result.status).toBe("completed");
    expect(remote.callTool).toHaveBeenCalledOnce();
  });

  it("verifyMcpToolIntegrity reports ok for an in-sync server without mutating it", async () => {
    const result = await verifyMcpToolIntegrity(server({ hasCredential: false }));

    expect(result).toMatchObject({ ok: true, changedTools: [], missingTools: [], unverifiable: false });
    expect(updateMcpServer).not.toHaveBeenCalled();
    expect(appendAuditLog).not.toHaveBeenCalled();
  });
});
