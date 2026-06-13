import { NextResponse } from "next/server";
import { forbidden, getAuthUser, unauthorized, requireRoleForRequest } from "@/lib/session";
import { store } from "@/lib/store";
import { withRlsContext } from "@/lib/with-rls";
import { getWorkbenchProvider } from "@/lib/workbench-provider";
import "@/lib/workbench-providers";

/**
 * Restore the session workspace to a captured checkpoint (run-start baseline
 * or a per-attempt checkpoint surfaced in the rollback event). Only providers
 * implementing the workspace-checkpoint capability can restore; everything
 * else honestly 409s rather than pretending.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getAuthUser();
  if (!user) return unauthorized();

  const { id } = await params;
  const session = await store.getWorkbenchSession(id);
  if (!session) return NextResponse.json({ error: "workbench session not found" }, { status: 404 });

  const check = await requireRoleForRequest(user.id, "member", { companyId: session.companyId });
  if (!check.ok) return forbidden();

  const body = await request.json().catch(() => ({})) as { checkpointId?: string };
  const checkpointId = body.checkpointId?.trim();
  if (!checkpointId) {
    return NextResponse.json({ error: "checkpointId is required" }, { status: 400 });
  }

  const provider = getWorkbenchProvider(session.provider);
  if (!provider.restoreWorkspaceCheckpoint) {
    return NextResponse.json(
      { error: `Provider ${session.provider} does not support workspace checkpoint restore.` },
      { status: 409 },
    );
  }

  const result = await withRlsContext(session.companyId, () =>
    provider.restoreWorkspaceCheckpoint!(session, checkpointId),
  );

  await store.addWorkbenchEvent({
    companyId: session.companyId,
    sessionId: session.id,
    type: "system",
    status: result.restored ? "completed" : "failed",
    title: result.restored ? "Workspace restored from checkpoint" : "Checkpoint restore failed",
    content: result.restored
      ? `Workspace restored to checkpoint ${checkpointId} (binaries and directories included; dependency dirs preserved).`
      : `Restore to checkpoint ${checkpointId} failed: ${result.detail ?? "unknown reason"}.`,
  }).catch(() => undefined);

  if (!result.restored) {
    return NextResponse.json({ error: result.detail ?? "restore failed" }, { status: 404 });
  }
  return NextResponse.json({ restored: true, checkpointId });
}
