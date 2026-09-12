import { NextResponse } from "next/server";
import { forbidden, getAuthUser, requireRoleForRequest, unauthorized } from "@/lib/session";
import { store } from "@/lib/store";
import { withRlsContext } from "@/lib/with-rls";
import { getWorkbenchProvider } from "@/lib/workbench-provider";
import "@/lib/workbench-providers";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getAuthUser();
  if (!user) return unauthorized();

  const { id } = await params;
  const session = await store.getWorkbenchSession(id);
  if (!session) return NextResponse.json({ error: "workbench session not found" }, { status: 404 });

  const check = await requireRoleForRequest(user.id, "member", { companyId: session.companyId });
  if (!check.ok) return forbidden();

  const provider = getWorkbenchProvider(session.provider);
  if (!provider.exportArtifacts) {
    return NextResponse.json({ error: `${session.provider} does not support artifact bundle export` }, { status: 501 });
  }

  // Hoist narrowed exportArtifacts into a const so TS narrowing is preserved inside the closure.
  const exportArtifacts = provider.exportArtifacts;
  const result = await withRlsContext(session.companyId, () => exportArtifacts(session));
  return NextResponse.json(result);
}
