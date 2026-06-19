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
import { createHash } from "crypto";
import { existsSync } from "fs";
import { join } from "path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { ToolAdapter } from "@/lib/tools";
import type { ToolCallRecord } from "@/lib/types";
import { appendAuditLog } from "@/lib/audit-log";
import { isAllowedStdioMcpUrl } from "@/lib/mcp-transport";
import {
  defaultMcpApprovalPolicyForTool,
  mcpApprovalPolicyAllowsExecution,
  mcpApprovalPolicyRequiresApproval,
  normalizeMcpApprovalPolicies,
} from "@/lib/mcp-policy";
import { rankMcpServersForTask } from "@/lib/mcp-tool-index";
import {
  getMcpServerToken,
  listEnabledMcpServers,
  updateMcpServer,
  type McpDiscoveredTool,
  type McpServerRecord,
} from "@/lib/mcp-store";

const MCP_CLIENT_INFO = { name: "trent-ai-cofounder", version: "1.0.0" };
const MCP_CALL_TIMEOUT_MS = 30_000;
const MCP_INTEGRITY_CACHE_TTL_MS = 60_000;
const SENTRY_STDIO_SKILLS = "inspect,docs";

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
  const client = new Client(MCP_CLIENT_INFO);
  if (server.transport === "stdio") {
    if (!isAllowedStdioMcpUrl(server.url)) {
      throw new Error("unsupported stdio MCP preset");
    }
    if (!token) {
      throw new Error("Sentry stdio MCP requires an encrypted token");
    }
    await client.connect(new StdioClientTransport({
      ...sentryMcpStdioCommand(),
      env: { ...stringProcessEnv(), SENTRY_ACCESS_TOKEN: token },
    }));
    return client;
  }

  const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
  const url = new URL(server.url);
  if (server.transport === "sse") {
    await client.connect(new SSEClientTransport(url, { requestInit: { headers } }));
    return client;
  }
  await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers } }));
  return client;
}

function stringProcessEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

function sentryMcpStdioCommand(): { command: string; args: string[] } {
  const localEntrypoint = join(process.cwd(), "node_modules", "@sentry", "mcp-server", "dist", "index.js");
  if (existsSync(localEntrypoint)) {
    return { command: process.execPath, args: [localEntrypoint, `--skills=${SENTRY_STDIO_SKILLS}`] };
  }
  return { command: "sentry-mcp", args: [`--skills=${SENTRY_STDIO_SKILLS}`] };
}

export function mcpToolDescriptionHash(name: string, description: string, metadata?: Record<string, unknown>): string {
  const richMetadata = metadata && Object.keys(metadata).length ? `\n${stableStringify(metadata)}` : "";
  return createHash("sha256").update(`${name}\n${description}${richMetadata}`).digest("hex");
}

/** Connect to the server and list its tools — used by the discover endpoint. */
export async function discoverMcpTools(server: McpServerRecord): Promise<McpDiscoveredTool[]> {
  const client = await connectMcpClient(server);
  try {
    const result = await client.listTools();
    return (result.tools ?? []).map((tool) => {
      const source = tool as Record<string, unknown> & { name: string; description?: string };
      const description = (tool.description ?? "").slice(0, 300);
      const metadata: Record<string, unknown> = {};
      if (typeof source.title === "string" && source.title) metadata.title = source.title;
      if (isRecord(source.inputSchema)) metadata.inputSchema = source.inputSchema;
      if (isRecord(source.outputSchema)) metadata.outputSchema = source.outputSchema;
      if (isRecord(source.annotations)) metadata.annotations = source.annotations;
      return {
        name: tool.name,
        ...(typeof source.title === "string" && source.title ? { title: source.title } : {}),
        description,
        ...(isRecord(source.inputSchema) ? { inputSchema: source.inputSchema } : {}),
        ...(isRecord(source.outputSchema) ? { outputSchema: source.outputSchema } : {}),
        ...(isRecord(source.annotations) ? { annotations: source.annotations } : {}),
        descriptionHash: mcpToolDescriptionHash(tool.name, description, metadata),
      };
    });
  } finally {
    await client.close().catch(() => undefined);
  }
}

export type McpIntegrityResult = {
  ok: boolean;
  changedTools: string[];
  missingTools: string[];
  unverifiable: boolean;
  checkedAt: string;
};

const integrityCache = new Map<string, { at: number; result: McpIntegrityResult }>();

export function clearMcpIntegrityCache(): void {
  integrityCache.clear();
}

function approvedHashedTools(server: McpServerRecord): McpDiscoveredTool[] {
  const approved = new Set(
    server.toolAllowlist.length ? server.toolAllowlist : server.discoveredTools.map((tool) => tool.name),
  );
  return server.discoveredTools.filter((tool) => tool.descriptionHash && approved.has(tool.name));
}

export async function verifyMcpToolIntegrity(server: McpServerRecord): Promise<McpIntegrityResult> {
  const baseline = approvedHashedTools(server);
  const checkedAt = new Date().toISOString();
  if (!baseline.length) {
    return { ok: true, changedTools: [], missingTools: [], unverifiable: false, checkedAt };
  }

  let live: McpDiscoveredTool[];
  try {
    live = await discoverMcpTools(server);
  } catch {
    return { ok: false, changedTools: [], missingTools: [], unverifiable: true, checkedAt };
  }

  const liveByName = new Map(live.map((tool) => [tool.name, tool]));
  const changedTools: string[] = [];
  const missingTools: string[] = [];
  for (const tool of baseline) {
    const liveTool = liveByName.get(tool.name);
    if (!liveTool) missingTools.push(tool.name);
    else if (!matchesApprovedToolHash(tool, liveTool)) changedTools.push(tool.name);
  }

  if (changedTools.length || missingTools.length) {
    const drift = [
      changedTools.length ? `changed: ${changedTools.join(", ")}` : "",
      missingTools.length ? `missing: ${missingTools.join(", ")}` : "",
    ].filter(Boolean).join("; ");
    await updateMcpServer(server.companyId, server.id, {
      status: "needs_reapproval",
      lastError: `Tool definitions changed since approval (${drift}). Re-discover and re-approve before agents may use the changed tools.`,
    }).catch(() => null);
    await appendAuditLog(
      server.companyId,
      "system",
      "mcp.tool_integrity.drift",
      "mcp_server",
      server.id,
      `MCP server "${server.name}" tool definitions changed since approval (${drift}) - possible rug-pull. Server marked needs_reapproval; changed tools blocked.`,
    ).catch(() => undefined);
    return { ok: false, changedTools, missingTools, unverifiable: false, checkedAt };
  }

  return { ok: true, changedTools: [], missingTools: [], unverifiable: false, checkedAt };
}

function matchesApprovedToolHash(approved: McpDiscoveredTool, live: McpDiscoveredTool): boolean {
  if (!approved.descriptionHash) return true;
  if (live.descriptionHash === approved.descriptionHash) return true;
  if (hasRichToolMetadata(approved)) return false;
  return mcpToolDescriptionHash(live.name, live.description) === approved.descriptionHash;
}

function hasRichToolMetadata(tool: McpDiscoveredTool): boolean {
  return Boolean(tool.title || tool.inputSchema || tool.outputSchema || tool.annotations);
}

async function verifyMcpToolIntegrityCached(server: McpServerRecord): Promise<McpIntegrityResult> {
  const cached = integrityCache.get(server.id);
  if (cached && Date.now() - cached.at < MCP_INTEGRITY_CACHE_TTL_MS) return cached.result;
  const result = await verifyMcpToolIntegrity(server);
  integrityCache.set(server.id, { at: Date.now(), result });
  return result;
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
  const approvalPolicies = normalizeMcpApprovalPolicies({
    rawPolicies: server.approvalPolicies,
    legacyReversibleTools: server.reversibleTools,
    discoveredTools: server.discoveredTools,
  });
  const toolByName = new Map(server.discoveredTools.map((tool) => [tool.name, tool]));
  const policyFor = (tool: string) =>
    approvalPolicies[tool] ?? defaultMcpApprovalPolicyForTool(toolByName.get(tool) ?? { name: tool });

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
      // Default-deny: only read-only-auto policies skip founder approval.
      const { tool } = parseMcpAction(action);
      return mcpApprovalPolicyRequiresApproval(policyFor(tool));
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
      const startedAt = Date.now();
      const { tool, args } = parseMcpAction(action);
      if (!allowed.has(tool)) {
        return {
          adapter: name,
          action,
          status: "failed",
          summary: `MCP tool "${tool}" is not in the allowlist for server "${server.name}". Allowed: ${[...allowed].join(", ") || "none discovered"}.`,
        };
      }
      const policy = policyFor(tool);
      if (!mcpApprovalPolicyAllowsExecution(policy)) {
        return {
          adapter: name,
          action,
          status: "failed",
          summary: `MCP tool "${tool}" is disabled by the connector approval policy for server "${server.name}".`,
        };
      }
      const hasBaseline = server.discoveredTools.some((item) => item.name === tool && item.descriptionHash);
      if (hasBaseline) {
        const integrity = await verifyMcpToolIntegrityCached(server);
        if (integrity.unverifiable) {
          return {
            adapter: name,
            action,
            status: "failed",
            summary: `MCP tool "${tool}" on ${server.name} was not executed: the tool definition could not be verified against its approved baseline.`,
          };
        }
        if (integrity.changedTools.includes(tool) || integrity.missingTools.includes(tool)) {
          return {
            adapter: name,
            action,
            status: "failed",
            summary: `MCP tool "${tool}" on ${server.name} is blocked: its definition changed since approval. Re-discover and re-approve before agents may use it.`,
          };
        }
      }
      try {
        const client = await connectMcpClient(server);
        try {
          const result = await client.callTool({ name: tool, arguments: args }, undefined, {
            timeout: MCP_CALL_TIMEOUT_MS,
          });
          const text = renderMcpResult(result as { content?: unknown; isError?: boolean });
          const failed = Boolean((result as { isError?: boolean }).isError);
          const record = {
            adapter: name,
            action,
            status: failed ? "failed" : "completed",
            summary: `[${server.name} · ${tool}] ${text}`.slice(0, 800),
          } satisfies ToolCallRecord;
          await appendMcpActivityTrace(server, tool, record.status, policy, args, Date.now() - startedAt);
          return record;
        } finally {
          await client.close().catch(() => undefined);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : "unknown MCP error";
        const record = {
          adapter: name,
          action,
          status: "failed",
          summary: `MCP call to ${server.name} failed: ${message.slice(0, 300)}`,
        } satisfies ToolCallRecord;
        await appendMcpActivityTrace(server, tool, record.status, policy, args, Date.now() - startedAt);
        return record;
      }
    },
  };
}

/** All enabled MCP servers for a company as ToolAdapters (merged into the seat registry). */
export async function getMcpAdaptersForCompany(
  companyId: string,
  options: { query?: string; limit?: number } = {},
): Promise<ToolAdapter[]> {
  if (!process.env.DATABASE_URL) return [];
  const servers = await listEnabledMcpServers(companyId).catch(() => []);
  const selected = options.query
    ? rankMcpServersForTask(servers, options.query, { limit: options.limit }).map((rank) => rank.server)
    : servers.slice(0, options.limit ?? servers.length);
  return selected.map(createMcpToolAdapter);
}

async function appendMcpActivityTrace(
  server: McpServerRecord,
  tool: string,
  status: ToolCallRecord["status"],
  policy: string,
  args: Record<string, unknown>,
  latencyMs: number,
): Promise<void> {
  await appendAuditLog(
    server.companyId,
    "agent",
    `mcp.tool_call.${status}`,
    "mcp_server",
    server.id,
    `MCP ${server.name}.${tool} ${status} policy=${policy} latencyMs=${latencyMs} args=${Object.keys(args).sort().join(",") || "none"}`,
  ).catch(() => undefined);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (!isRecord(value)) return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}
