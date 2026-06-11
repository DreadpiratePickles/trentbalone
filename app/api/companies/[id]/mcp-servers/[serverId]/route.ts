import { NextRequest, NextResponse } from "next/server";
import { getAuthUser, unauthorized, forbidden, requireRoleForRequest } from "@/lib/session";
import { deleteMcpServer, updateMcpServer, type McpDiscoveredTool } from "@/lib/mcp-store";

/** PATCH /api/companies/:id/mcp-servers/:serverId — edit allowlist/policy/credentials. */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; serverId: string }> },
) {
  const user = await getAuthUser();
  if (!user) return unauthorized();
  const { id: companyId, serverId } = await params;
  const check = await requireRoleForRequest(user.id, "member", { companyId });
  if (!check.ok) return forbidden();

  const body = (await request.json().catch(() => ({}))) as {
    name?: string;
    url?: string;
    transport?: string;
    token?: string;
    toolAllowlist?: unknown;
    reversibleTools?: unknown;
    enabled?: boolean;
  };
  const toStringArray = (value: unknown) =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined;

  const patch: Parameters<typeof updateMcpServer>[2] = {};
  if (typeof body.name === "string" && body.name.trim()) patch.name = body.name.trim();
  if (typeof body.url === "string" && body.url.trim()) patch.url = body.url.trim();
  if (body.transport === "sse" || body.transport === "http") patch.transport = body.transport;
  if (typeof body.token === "string") patch.token = body.token.trim();
  const allow = toStringArray(body.toolAllowlist);
  if (allow) patch.toolAllowlist = allow;
  const reversible = toStringArray(body.reversibleTools);
  if (reversible) patch.reversibleTools = reversible;
  if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "no valid fields to update" }, { status: 400 });
  }

  const server = await updateMcpServer(companyId, serverId, patch);
  if (!server) return NextResponse.json({ error: "MCP server not found" }, { status: 404 });
  return NextResponse.json({ server });
}

/** DELETE /api/companies/:id/mcp-servers/:serverId — disconnect a server. */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; serverId: string }> },
) {
  const user = await getAuthUser();
  if (!user) return unauthorized();
  const { id: companyId, serverId } = await params;
  const check = await requireRoleForRequest(user.id, "member", { companyId });
  if (!check.ok) return forbidden();

  const removed = await deleteMcpServer(companyId, serverId);
  if (!removed) return NextResponse.json({ error: "MCP server not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}

export type { McpDiscoveredTool };
