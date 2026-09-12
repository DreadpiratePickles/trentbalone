import { NextRequest, NextResponse } from "next/server";
import { getAuthUser, unauthorized, forbidden, requireRoleForRequest } from "@/lib/session";
import { getGoal, updateGoal, appendGoalProgress } from "@/lib/goal-store";
import { nowIso } from "@/lib/utils";
import { successCriterionSchema, type SuccessCriterion } from "@/lib/goal-types";

async function loadGoal(goalId: string, companyId: string) {
  const goal = await getGoal(goalId);
  if (!goal || goal.companyId !== companyId) return null;
  return goal;
}

/** GET one goal. */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string; goalId: string }> }) {
  const user = await getAuthUser();
  if (!user) return unauthorized();
  const { id: companyId, goalId } = await params;
  const check = await requireRoleForRequest(user.id, "viewer", { companyId });
  if (!check.ok) return forbidden();
  const goal = await loadGoal(goalId, companyId);
  if (!goal) return NextResponse.json({ error: "Goal not found" }, { status: 404 });
  return NextResponse.json({ goal });
}

/**
 * PATCH a goal — HUMAN GATE actions:
 *   { action: "approve_criteria", successCriteria?: [{id,text}] } → activate goal
 *   { action: "edit_criteria", successCriteria: [...] }
 *   { action: "stop" }
 *   { action: "edit_objective", objective }
 */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string; goalId: string }> }) {
  const user = await getAuthUser();
  if (!user) return unauthorized();
  const { id: companyId, goalId } = await params;
  const check = await requireRoleForRequest(user.id, "member", { companyId });
  if (!check.ok) return forbidden();

  const goal = await loadGoal(goalId, companyId);
  if (!goal) return NextResponse.json({ error: "Goal not found" }, { status: 404 });

  const body = (await request.json().catch(() => ({}))) as {
    action?: string;
    successCriteria?: Array<{ id?: string; text: string; status?: string }>;
    objective?: string;
  };

  if (body.action === "stop") {
    const updated = await updateGoal(goalId, { status: "stopped" });
    await appendGoalProgress(goalId, { at: nowIso(), kind: "stopped", text: "Goal stopped by founder.", refs: [] });
    return NextResponse.json({ goal: updated });
  }

  if (body.action === "approve_criteria" || body.action === "edit_criteria") {
    let criteria: SuccessCriterion[] = goal.successCriteria;
    if (Array.isArray(body.successCriteria) && body.successCriteria.length > 0) {
      criteria = body.successCriteria.map((c, i) =>
        successCriterionSchema.parse({
          id: c.id ?? `crit_${i}`,
          text: c.text,
          status: c.status ?? "unmet",
          evidenceArtifactIds: [],
        }),
      );
    }
    const updated = await updateGoal(goalId, { successCriteria: criteria, status: "active" });
    await appendGoalProgress(goalId, {
      at: nowIso(),
      kind: "criteria_approved",
      text: `Founder approved ${criteria.length} success criteria; goal active.`,
      refs: [],
    });
    return NextResponse.json({ goal: updated });
  }

  if (body.action === "edit_objective" && body.objective) {
    const updated = await updateGoal(goalId, { objective: body.objective });
    await appendGoalProgress(goalId, { at: nowIso(), kind: "edited", text: "Founder edited the objective.", refs: [] });
    return NextResponse.json({ goal: updated });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
