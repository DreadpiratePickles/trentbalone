import { NextResponse } from "next/server";
import { forbidden, getAuthUser, requireRoleForRequest, unauthorized } from "@/lib/session";
import { getOrchestrationRunSnapshot } from "@/lib/orchestrator";
import { store } from "@/lib/store";
import { evaluateRunToCompletion, type RunToCompletionStep } from "@/lib/orchestrator-run-to-completion";

/**
 * "Run to completion" gate preview (orchestration guide Task 4.4).
 *
 *   GET /api/companies/[id]/orchestrate/run-to-completion?runId=...
 *
 * Read-only: returns whether the run may auto-advance ("continue"), must stop
 * for a founder gate ("pause", with the blocking step), or is finished
 * ("done"). The UI button uses this to decide whether to keep going or surface
 * an approval. It NEVER mutates the run — approvals still flow through the
 * existing approve route.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getAuthUser();
  if (!user) return unauthorized();
  const { id: companyId } = await params;
  const check = await requireRoleForRequest(user.id, "viewer", { companyId });
  if (!check.ok) return forbidden();

  const runId = new URL(request.url).searchParams.get("runId");
  if (!runId) {
    return NextResponse.json({ error: "runId required" }, { status: 400 });
  }

  const run = await getOrchestrationRunSnapshot(runId);
  if (!run || run.companyId !== companyId) {
    return NextResponse.json({ error: "run not found" }, { status: 404 });
  }

  const steps: RunToCompletionStep[] = (run.steps ?? []).map((step) => ({
    id: step.id,
    title: step.title,
    status: step.status,
    needsApproval: step.needsApproval,
    riskLevel: step.riskLevel,
    costCents: step.costCents,
  }));

  // The in-memory run carries neither budget nor a rolled-up cost: cost is the
  // sum of step spend, and the cap lives on the persisted record.
  const costCents = steps.reduce((total, step) => total + (step.costCents ?? 0), 0);
  const persisted = await store.getOrchestratorRun(runId).catch(() => undefined);

  const decision = evaluateRunToCompletion({
    steps,
    budgetCents: persisted?.budgetCents,
    costCents,
  });

  return NextResponse.json({ runId, status: run.status, decision });
}
