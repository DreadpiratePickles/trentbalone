import { NextResponse } from "next/server";
import { forbidden, getAuthUser, unauthorized, requireRoleForRequest } from "@/lib/session";
import { store } from "@/lib/store";
import { withRlsContext } from "@/lib/with-rls";
import { nowIso } from "@/lib/utils";
import type { WorkbenchSessionStatus } from "@/lib/types";
import {
  recordAppSoloHeartbeat,
  resumeAppSoloWorkbenchSession,
  stopWorkbenchSession,
} from "@/lib/workbench-orchestrator";

const statuses: WorkbenchSessionStatus[] = ["queued", "starting", "running", "paused", "completed", "failed", "cancelled"];
const terminalStatuses = new Set<WorkbenchSessionStatus>(["completed", "failed", "cancelled"]);

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getAuthUser();
  if (!user) return unauthorized();

  const { id } = await params;
  const session = await store.getWorkbenchSession(id);
  if (!session) return NextResponse.json({ error: "workbench session not found" }, { status: 404 });

  const check = await requireRoleForRequest(user.id, "viewer", { companyId: session.companyId });
  if (!check.ok) return forbidden();

  const [events, artifacts] = await withRlsContext(session.companyId, () => Promise.all([
    store.listWorkbenchEvents(session.id),
    store.listWorkbenchArtifacts(session.id)
  ]));

  return NextResponse.json({ session, events, artifacts });
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getAuthUser();
  if (!user) return unauthorized();

  const { id } = await params;
  const existing = await store.getWorkbenchSession(id);
  if (!existing) return NextResponse.json({ error: "workbench session not found" }, { status: 404 });

  const check = await requireRoleForRequest(user.id, "member", { companyId: existing.companyId });
  if (!check.ok) return forbidden();

  const body = await request.json() as {
    action?: "app_solo_heartbeat" | "app_solo_resume";
    status?: WorkbenchSessionStatus;
    previewUrl?: string;
    costCents?: number;
    objective?: string;
  };

  if (body.action === "app_solo_heartbeat") {
    const session = await withRlsContext(existing.companyId, () => recordAppSoloHeartbeat(id));
    return NextResponse.json({ session });
  }

  if (body.action === "app_solo_resume") {
    const session = await withRlsContext(existing.companyId, () => resumeAppSoloWorkbenchSession(id));
    return NextResponse.json({ session });
  }

  if (body.status && !statuses.includes(body.status)) {
    return NextResponse.json({ error: "Unsupported workbench status" }, { status: 400 });
  }

  if (body.status === "cancelled" && body.status !== existing.status) {
    await stopWorkbenchSession(id, "cancelled");
    const session = await withRlsContext(existing.companyId, () => store.getWorkbenchSession(id));
    return NextResponse.json({ session });
  }

  return withRlsContext(existing.companyId, async () => {
    const terminal = body.status ? terminalStatuses.has(body.status) : false;
    const session = await store.updateWorkbenchSession(id, {
      status: body.status,
      objective: body.objective?.trim() || undefined,
      previewUrl: body.previewUrl,
      costCents: body.costCents,
      stoppedAt: terminal ? nowIso() : existing.stoppedAt
    });

    if (body.status && body.status !== existing.status) {
      await store.addWorkbenchEvent({
        companyId: existing.companyId,
        sessionId: existing.id,
        type: "system",
        status: body.status === "failed" ? "failed" : "completed",
        title: `Session ${body.status}`,
        content: `Workbench status changed from ${existing.status} to ${body.status}.`
      });
    }

    if (body.objective?.trim() && body.objective.trim() !== existing.objective) {
      await store.addWorkbenchEvent({
        companyId: existing.companyId,
        sessionId: existing.id,
        type: "system",
        status: "completed",
        title: "Session renamed",
        content: `Workbench objective changed from "${existing.objective}" to "${body.objective.trim()}".`
      });
    }

    return NextResponse.json({ session });
  });
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getAuthUser();
  if (!user) return unauthorized();

  const { id } = await params;
  const existing = await store.getWorkbenchSession(id);
  if (!existing) return NextResponse.json({ error: "workbench session not found" }, { status: 404 });

  const check = await requireRoleForRequest(user.id, "member", { companyId: existing.companyId });
  if (!check.ok) return forbidden();

  if (!terminalStatuses.has(existing.status)) {
    await stopWorkbenchSession(id, "cancelled");
  }

  const deleted = await withRlsContext(existing.companyId, () => store.deleteWorkbenchSession(id));
  return NextResponse.json({ deleted });
}
