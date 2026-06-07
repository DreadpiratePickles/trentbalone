import { NextResponse } from "next/server";
import { forbidden, getAuthUser, unauthorized, requireRoleForRequest } from "@/lib/session";
import { store } from "@/lib/store";
import { withRlsContext } from "@/lib/with-rls";
import { getWorkbenchProvider } from "@/lib/workbench-provider";
// Register the local provider so it's available
import "@/lib/workbench-local-provider";

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

  const body = await request.json() as {
    command?: string;
    cwd?: string;
    timeoutMs?: number;
  };

  if (!body.command?.trim()) {
    return NextResponse.json({ error: "command is required" }, { status: 400 });
  }

  const provider = getWorkbenchProvider(session.provider);
  // Hoist narrowed command before entering the closure (preserves TS narrowing).
  const command = body.command.trim();
  const result = await withRlsContext(session.companyId, () => provider.exec(session, command, {
    cwd: body.cwd,
    timeoutMs: body.timeoutMs
  }));

  return NextResponse.json({ result });
}
