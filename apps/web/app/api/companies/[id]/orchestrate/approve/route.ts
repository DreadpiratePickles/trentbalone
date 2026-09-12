import { NextRequest, NextResponse } from "next/server";
import { forbidden, getAuthUser, requireRoleForRequest, unauthorized } from "@/lib/session";
import { approveStep, rejectStep, getOrchestrationRun, getOrchestrationRunSnapshot } from "@/lib/orchestrator";

/**
 * Founder approves (or rejects) a single step in an orchestrated run.
 *   POST /api/companies/[id]/orchestrate/approve
 *   Body: { runId, stepId, decision: "approve" | "reject" }
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getAuthUser();
  if (!user) return unauthorized();
  const { id: companyId } = await params;
  const check = await requireRoleForRequest(user.id, "member", { companyId });
  if (!check.ok) return forbidden();

  const body = (await request.json().catch(() => ({}))) as {
    runId?: string;
    stepId?: string;
    decision?: "approve" | "reject";
  };
  if (!body.runId || !body.stepId || !body.decision) {
    return NextResponse.json({ error: "runId, stepId, decision required" }, { status: 400 });
  }

  const run = getOrchestrationRun(body.runId) ?? await getOrchestrationRunSnapshot(body.runId);
  if (!run || run.companyId !== companyId) {
    return NextResponse.json({ error: "run not found" }, { status: 404 });
  }

  const ok = body.decision === "approve"
    ? approveStep(body.runId, body.stepId)
    : rejectStep(body.runId, body.stepId);
  const resolved = await ok;

  if (!resolved) {
    return NextResponse.json({ error: "no pending approval for that step" }, { status: 409 });
  }

  return NextResponse.json({ ok: true, decision: body.decision });
}
