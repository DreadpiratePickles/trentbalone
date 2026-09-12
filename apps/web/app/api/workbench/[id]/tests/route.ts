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

  if (session.status !== "running") {
    return NextResponse.json({ error: `Session is ${session.status}, not running` }, { status: 409 });
  }

  const body = await request.json().catch(() => ({})) as { command?: string };
  const provider = getWorkbenchProvider(session.provider);
  const result = await withRlsContext(session.companyId, () => provider.runTests(session, body.command));

  return NextResponse.json({ result });
}
