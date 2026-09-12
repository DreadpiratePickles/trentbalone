import { NextRequest, NextResponse } from "next/server";
import { forbidden, getAuthUser, requireRoleForRequest, unauthorized } from "@/lib/session";
import { store } from "@/lib/store";
import { buildOrchestratorTraceReplay } from "@/lib/orchestrator-trace-replay";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getAuthUser();
  if (!user) return unauthorized();

  const { id: companyId } = await params;
  const check = await requireRoleForRequest(user.id, "viewer", { companyId });
  if (!check.ok) return forbidden();

  const runId = new URL(request.url).searchParams.get("runId");
  if (!runId) return NextResponse.json({ error: "runId required" }, { status: 400 });

  const run = await store.getOrchestratorRun(runId);
  if (!run || run.companyId !== companyId) {
    return NextResponse.json({ error: "run not found" }, { status: 404 });
  }

  const [steps, events] = await Promise.all([
    store.listOrchestratorSteps(runId),
    store.listOrchestratorEvents(runId),
  ]);

  return NextResponse.json({ trace: buildOrchestratorTraceReplay({ run, steps, events }) });
}
