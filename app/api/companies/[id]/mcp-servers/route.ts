import { NextRequest, NextResponse } from "next/server";
import { getAuthUser, unauthorized, forbidden, requireRoleForRequest } from "@/lib/session";
import { createMcpServer, listMcpServers } from "@/lib/mcp-store";
import { validateMcpServerTarget } from "@/lib/mcp-transport";
import { normalizeMcpApprovalPolicies } from "@/lib/mcp-policy";

/** GET /api/companies/:id/mcp-servers — list client-connected MCP servers (§3.3). */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getAuthUser();
  if (!user) return unauthorized();
  const { id: companyId } = await params;
  const check = await requireRoleForRequest(user.id, "viewer", { companyId });
  if (!check.ok) return forbidden();
  return NextResponse.json({ servers: await listMcpServers(companyId) });
}

/** POST /api/companies/:id/mcp-servers — connect a new MCP server or approved local preset. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getAuthUser();
  if (!user) return unauthorized();
  const { id: companyId } = await params;
  const check = await requireRoleForRequest(user.id, "member", { companyId });
  if (!check.ok) return forbidden();

  const body = (await request.json().catch(() => ({}))) as {
    name?: string;
    url?: string;
    transport?: string;
    token?: string;
    toolAllowlist?: unknown;
    reversibleTools?: unknown;
    approvalPolicies?: unknown;
  };
  const name = body.name?.trim();
  const url = body.url?.trim();
  if (!name || !url) return NextResponse.json({ error: "name and url are required" }, { status: 400 });
  const target = validateMcpServerTarget({ url, transport: body.transport });
  if (!target.ok) return NextResponse.json({ error: target.error }, { status: 400 });

  const toStringArray = (value: unknown) =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

  const server = await createMcpServer({
    companyId,
    name,
    url: target.url,
    transport: target.transport,
    token: body.token?.trim() || undefined,
    toolAllowlist: toStringArray(body.toolAllowlist),
    reversibleTools: toStringArray(body.reversibleTools),
    approvalPolicies: body.approvalPolicies
      ? normalizeMcpApprovalPolicies({ rawPolicies: body.approvalPolicies })
      : undefined,
  });
  return NextResponse.json({ server }, { status: 201 });
}
