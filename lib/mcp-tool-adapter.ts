/**
 * lib/mcp-tool-adapter.ts — §3.3 the McpToolAdapter.
 *
 * The tool layer is an adapter registry (lib/tools.ts ToolAdapter) and seats
 * reach tools through the seat agent loop, so MCP support is one adapter class:
 * each client-configured MCP server becomes a ToolAdapter named
 * `mcp_<server>` whose actions are the server's tools (namespaced — e.g. the
 * seat calls tool "mcp_hubspot" with action "create_contact"). Everything
 * downstream already works: external-action-guardrails gates execution and the
 * durable approval spine pauses/resumes the seat loop.
 *
 * SAFETY DEFAULT: every MCP tool requires approval until the client explicitly
 * marks it reversible — connecting a CRM's MCP server hands agents live write
 * access, so the approval/audit spine is what makes this safe to offer.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { ToolAdapter } from "@/lib/tools";
import type { ToolCallRecord } from "@/lib/types";
import { getMcpServerToken, listEnabledMcpServers, type McpDiscoveredTool, type McpServerRecord } from "@/lib/mcp-store";

const MCP_CLIENT_INFO = { name: "trent-ai-cofounder", version: "1.0.0" };
const MCP_CALL_TIMEOUT_MS = 30_000;

export function mcpAdapterName(serverName: string): string {
  const slug = serverName.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return `mcp_${slug || "server"}`;
}

/**
 * Parse a seat-emitted action of the form `tool_name` or `tool_name {"k":"v"}`
 * into the MCP tool name plus optional JSON arguments.
 */
export function parseMcpAction(action: string): { tool: string; args: Record<string, unknown> } {
  const trimmed = action.trim();
  const braceIndex = trimmed.indexOf("{");
  if (braceIndex === -1) return { tool: trimmed.split(/\s+/)[0] ?? trimmed, args: {} };
  const tool = trimmed.slice(0, braceIndex).trim().split(/\s+/)[0] ?? "";
  try {
    const parsed = JSON.parse(trimmed.slice(braceIndex));
    return {
      tool,
      args: parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {},
    };
  } catch {
    return { tool, args: {} };
  }
}

async function connectMcpClient(server: McpServerRecord): Promise<Client> {
  const token = server.hasCredential ? await getMcpServerToken(server.companyId, server.id) : undefined;
  const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
  const client = new Client(MCP_CLIENT_INFO);
  const url = new URL(server.url);
  if (server.transport === "sse") {
    await client.connect(new SSEClientTransport(url, { requestInit: { headers } }));
    return client;
  }
  await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers } }));
  return client;
}

/** Connect to the server and list its tools — used by the discover endpoint. */
export async function discoverMcpTools(server: McpServerRecord): Promise<McpDiscoveredTool[]> {
  const client = await connectMcpClient(server);
  try {
    const result = await client.listTools();
    return (result.tools ?? []).map((tool) => ({
      name: tool.name,
      description: (tool.description ?? "").slice(0, 300),
    }));
  } finally {
    await client.close().catch(() => undefined);
  }
}

function renderMcpResult(result: { content?: unknown; isError?: boolean }): string {
  const content = Array.isArray(result.content) ? result.content : [];
  const text = content
    .filter((item): item is Record<string, unknown> => item !== null && typeof item === "object")
    .map((item) => (typeof item.text === "string" ? item.text : JSON.stringify(item)))
    .join("\n");
  return text || "MCP tool returned no content.";
}

export function createMcpToolAdapter(server: McpServerRecord): ToolAdapter {
  const name = mcpAdapterName(server.name);
  const knownTools = server.discoveredTools.map((tool) => tool.name);
  const allowed = new Set(server.toolAllowlist.length ? server.toolAllowlist : knownTools);
  const reversible = new Set(server.reversibleTools);

  return {
    name,
    scopes: [...allowed].map((tool) => `mcp:${tool}`),
    availability: server.enabled && server.status === "connected" ? "real" : "unavailable",
    async healthCheck() {
      return server.status === "connected" ? "connected" : "needs_credentials";
    },
    estimateCost() {
      return 0;
    },
    requiresApproval(action: string) {
      // Default-deny: only tools the client explicitly marked reversible skip approval.
      const { tool } = parseMcpAction(action);
      return !reversible.has(tool);
    },
    async dryRun(action: string): Promise<ToolCallRecord> {
      const { tool } = parseMcpAction(action);
      return {
        adapter: name,
        action,
        status: "needs_approval",
        summary: `MCP tool "${tool}" on ${server.name} (${server.url}) requires founder approval before Trent acts in the client's live system.`,
      };
    },
    async execute(action: string): Promise<ToolCallRecord> {
      const { tool, args } = parseMcpAction(action);
      if (!allowed.has(tool)) {
        return {
          adapter: name,
          action,
          status: "failed",
          summary: `MCP tool "${tool}" is not in the allowlist for server "${server.name}". Allowed: ${[...allowed].join(", ") || "none discovered"}.`,
        };
      }
      try {
        const client = await connectMcpClient(server);
        try {
          const result = await client.callTool({ name: tool, arguments: args }, undefined, {
            timeout: MCP_CALL_TIMEOUT_MS,
          });
          const text = renderMcpResult(result as { content?: unknown; isError?: boolean });
          const failed = Boolean((result as { isError?: boolean }).isError);
          return {
            adapter: name,
            action,
            status: failed ? "failed" : "completed",
            summary: `[${server.name} · ${tool}] ${text}`.slice(0, 800),
          };
        } finally {
          await client.close().catch(() => undefined);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : "unknown MCP error";
        return {
          adapter: name,
          action,
          status: "failed",
          summary: `MCP call to ${server.name} failed: ${message.slice(0, 300)}`,
        };
      }
    },
  };
}

/** All enabled MCP servers for a company as ToolAdapters (merged into the seat registry). */
export async function getMcpAdaptersForCompany(companyId: string): Promise<ToolAdapter[]> {
  if (!process.env.DATABASE_URL) return [];
  const servers = await listEnabledMcpServers(companyId).catch(() => []);
  return servers.map(createMcpToolAdapter);
}
