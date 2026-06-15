import { NextResponse } from "next/server";
import { store } from "@/lib/store";
import { getAuthUser, unauthorized, forbidden, requireRoleForRequest } from "@/lib/session";
import { resolveSupervisionApprovalExecution } from "@/lib/supervision/approval-execution";
import { syncContentMissionForApproval } from "@/lib/content-mission-approval-hook";
import { syncAgentMissionForApproval } from "@/lib/agent-mission-approval-hook";
import { withRlsContext } from "@/lib/with-rls";
import { clearWorkbenchPlanGateForApproval } from "@/lib/workbench-approval-gate";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getAuthUser();
  if (!user) return unauthorized();

  const { id } = await params;
  const existing = await store.getApproval(id);
  if (!existing) return NextResponse.json({ error: "Approval not found" }, { status: 404 });

  const check = await requireRoleForRequest(user.id, "member", { companyId: existing.companyId });
  if (!check.ok) return forbidden();

  const status = (await request.json()).status;
  if (status !== "approved" && status !== "rejected") {
    return NextResponse.json({ error: "status must be approved or rejected" }, { status: 400 });
  }
  return withRlsContext(existing.companyId, async () => {
    const approval = await store.resolveApproval(id, status);
    if (approval?.taskId) {
      await store.updateTask(approval.taskId, {
        status: status === "approved" ? "queued" : "blocked"
      });
    }
    if (approval) {
      if (status === "approved") {
        await clearWorkbenchPlanGateForApproval(approval).catch(() => undefined);
      }
      await resolveSupervisionApprovalExecution({ approval, status });
      await syncContentMissionForApproval(approval).catch(() => undefined);
      await syncAgentMissionForApproval(approval).catch(() => undefined);
    }
    return NextResponse.json({ approval });
  });
}
