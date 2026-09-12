import { NextRequest, NextResponse } from "next/server";
import { getAuthUser, unauthorized, forbidden, requireRoleForRequest } from "@/lib/session";
import { getMcpServer, updateMcpServer } from "@/lib/mcp-store";
import { discoverMcpTools } from "@/lib/mcp-tool-adapter";

export const maxDuration = 60;

/**
 * POST /api/companies/:id/mcp-servers/:serverId/discover — connect to the
 * remote MCP server, list its tools, and persist them. Marks the server
 * connected on success / error with detail on failure.
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; serverId: string }> },
) {
  const user = await getAuthUser();
  if (!user) return unauthorized();
  const { id: companyId, serverId } = await params;
  const check = await requireRoleForRequest(user.id, "member", { companyId });
  if (!check.ok) return forbidden();

  const server = await getMcpServer(companyId, serverId);
  if (!server) return NextResponse.json({ error: "MCP server not found" }, { status: 404 });

  try {
    const tools = await discoverMcpTools(server);
    const updated = await updateMcpServer(companyId, serverId, {
      discoveredTools: tools,
      status: "connected",
      lastError: null,
    });
    return NextResponse.json({ server: updated, toolCount: tools.length });
  } catch (err) {
    const message = err instanceof Error ? err.message : "MCP discovery failed";
    const updated = await updateMcpServer(companyId, serverId, {
      status: "error",
      lastError: message.slice(0, 500),
    });
    return NextResponse.json({ server: updated, error: message }, { status: 502 });
  }
}
