import { NextResponse } from "next/server";
import { forbidden, getAuthUser, unauthorized, requireRoleForRequest } from "@/lib/session";
import { store } from "@/lib/store";
import { withRlsContext } from "@/lib/with-rls";
import { startWorkbenchSessionAfterImports } from "@/lib/workbench-session-start";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getAuthUser();
  if (!user) return unauthorized();

  const { id } = await params;
  const existing = await store.getWorkbenchSession(id);
  if (!existing) return NextResponse.json({ error: "workbench session not found" }, { status: 404 });

  const check = await requireRoleForRequest(user.id, "member", { companyId: existing.companyId });
  if (!check.ok) return forbidden();

  try {
    const session = await withRlsContext(existing.companyId, () => startWorkbenchSessionAfterImports(id));
    return NextResponse.json({ session });
  } catch (err) {
    return NextResponse.json({
      error: err instanceof Error ? err.message : "Workbench start failed",
      retryable: true,
    }, { status: 502 });
  }
}
