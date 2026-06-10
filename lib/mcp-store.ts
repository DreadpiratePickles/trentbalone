/**
 * lib/mcp-store.ts — §3.3 client-added MCP servers persistence.
 *
 * A remote MCP endpoint a client connects so Trent's seats can act in the
 * client's own tools. Auth tokens are stored encrypted via lib/secrets
 * (the existing credential-boundary pattern); API reads only expose a masked
 * indicator. Every MCP tool defaults to requires-approval until the client
 * explicitly marks it reversible.
 */
import { db } from "@/lib/db";
import { makeId } from "@/lib/utils";
import { decryptJson, encryptJson } from "@/lib/secrets";

export type McpDiscoveredTool = { name: string; description: string };

export type McpServerRecord = {
  id: string;
  companyId: string;
  name: string;
  url: string;
  transport: "http" | "sse";
  hasCredential: boolean;
  toolAllowlist: string[];
  reversibleTools: string[];
  status: string;
  lastError?: string;
  discoveredTools: McpDiscoveredTool[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

type Row = {
  id: string;
  companyId: string;
  name: string;
  url: string;
  transport: string;
  credentialRef: string | null;
  toolAllowlist: unknown;
  reversibleTools: unknown;
  status: string;
  lastError: string | null;
  discoveredTools: unknown;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
};

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function toDiscoveredTools(value: unknown): McpDiscoveredTool[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => item !== null && typeof item === "object")
    .map((item) => ({
      name: typeof item.name === "string" ? item.name : "",
      description: typeof item.description === "string" ? item.description : "",
    }))
    .filter((item) => item.name.length > 0);
}

function fromRow(row: Row): McpServerRecord {
  return {
    id: row.id,
    companyId: row.companyId,
    name: row.name,
    url: row.url,
    transport: row.transport === "sse" ? "sse" : "http",
    hasCredential: Boolean(row.credentialRef),
    toolAllowlist: toStringArray(row.toolAllowlist),
    reversibleTools: toStringArray(row.reversibleTools),
    status: row.status,
    lastError: row.lastError ?? undefined,
    discoveredTools: toDiscoveredTools(row.discoveredTools),
    enabled: row.enabled,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function listMcpServers(companyId: string): Promise<McpServerRecord[]> {
  const rows = await db.mcpServer.findMany({ where: { companyId }, orderBy: { createdAt: "asc" } });
  return rows.map(fromRow);
}

export async function listEnabledMcpServers(companyId: string): Promise<McpServerRecord[]> {
  const rows = await db.mcpServer.findMany({
    where: { companyId, enabled: true },
    orderBy: { createdAt: "asc" },
  });
  return rows.map(fromRow);
}

export async function getMcpServer(companyId: string, id: string): Promise<McpServerRecord | null> {
  const row = await db.mcpServer.findFirst({ where: { id, companyId } });
  return row ? fromRow(row) : null;
}

/** Decrypted auth token for a server — only used by the adapter transport. */
export async function getMcpServerToken(companyId: string, id: string): Promise<string | undefined> {
  const row = await db.mcpServer.findFirst({ where: { id, companyId }, select: { credentialRef: true } });
  if (!row?.credentialRef) return undefined;
  try {
    return decryptJson<{ token: string }>(row.credentialRef).token;
  } catch {
    return undefined;
  }
}

export async function createMcpServer(input: {
  companyId: string;
  name: string;
  url: string;
  transport?: "http" | "sse";
  token?: string;
  toolAllowlist?: string[];
  reversibleTools?: string[];
}): Promise<McpServerRecord> {
  const row = await db.mcpServer.create({
    data: {
      id: makeId("mcp"),
      companyId: input.companyId,
      name: input.name,
      url: input.url,
      transport: input.transport ?? "http",
      credentialRef: input.token ? encryptJson({ token: input.token }) : null,
      toolAllowlist: input.toolAllowlist ?? [],
      reversibleTools: input.reversibleTools ?? [],
      discoveredTools: [],
      status: "configured",
      enabled: true,
    },
  });
  return fromRow(row);
}

export async function updateMcpServer(
  companyId: string,
  id: string,
  patch: Partial<{
    name: string;
    url: string;
    transport: "http" | "sse";
    token: string;
    toolAllowlist: string[];
    reversibleTools: string[];
    discoveredTools: McpDiscoveredTool[];
    status: string;
    lastError: string | null;
    enabled: boolean;
  }>,
): Promise<McpServerRecord | null> {
  const { token, ...rest } = patch;
  const data: Record<string, unknown> = { ...rest };
  if (typeof token === "string") {
    data.credentialRef = token ? encryptJson({ token }) : null;
  }
  const { count } = await db.mcpServer.updateMany({ where: { id, companyId }, data });
  if (count === 0) return null;
  const row = await db.mcpServer.findUnique({ where: { id } });
  return row ? fromRow(row) : null;
}

export async function deleteMcpServer(companyId: string, id: string): Promise<boolean> {
  const { count } = await db.mcpServer.deleteMany({ where: { id, companyId } });
  return count > 0;
}
