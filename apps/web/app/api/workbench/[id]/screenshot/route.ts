import { NextResponse } from "next/server";
import { forbidden, getAuthUser, unauthorized, requireRoleForRequest } from "@/lib/session";
import { store } from "@/lib/store";
import { withRlsContext } from "@/lib/with-rls";
import { getWorkbenchProvider } from "@/lib/workbench-provider";
import "@/lib/workbench-providers";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getAuthUser();
  if (!user) return unauthorized();

  const { id } = await params;
  const session = await store.getWorkbenchSession(id);
  if (!session) return NextResponse.json({ error: "workbench session not found" }, { status: 404 });

  const check = await requireRoleForRequest(user.id, "member", { companyId: session.companyId });
  if (!check.ok) return forbidden();

  const body = await request.json().catch(() => ({})) as {
    url?: string;
    width?: number;
    height?: number;
  };

  const provider = getWorkbenchProvider(session.provider);
  const result = await withRlsContext(session.companyId, () => provider.screenshot(session, {
    url: body.url,
    width: body.width,
    height: body.height
  }));

  // Don't send the full dataUri in the response (can be large); client can fetch from artifact
  return NextResponse.json({
    storageKey: result.storageKey,
    width: result.width,
    height: result.height
  });
}
