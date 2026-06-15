import { NextResponse } from "next/server";
import { forbidden, getAuthUser, requireRoleForRequest, unauthorized } from "@/lib/session";
import { buildConnectorMatrix } from "@/lib/connector-matrix";
import { listMcpServers } from "@/lib/mcp-store";
import { withRlsContext } from "@/lib/with-rls";

type Params = { params: Promise<{ id: string }> | { id: string } };

export async function GET(_request: Request, context: Params) {
  const user = await getAuthUser();
  if (!user) return unauthorized();
  const { id: companyId } = await context.params;

  const check = await requireRoleForRequest(user.id, "viewer", { companyId });
  if (!check.ok) return forbidden();

  return withRlsContext(companyId, async () => {
    const mcpServerCount = await listMcpServers(companyId).then((servers) => servers.length).catch(() => 0);
    return NextResponse.json({ matrix: buildConnectorMatrix({ mcpServerCount }) });
  });
}
