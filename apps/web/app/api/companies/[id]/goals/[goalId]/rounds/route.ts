import { NextRequest, NextResponse } from "next/server";
import { getAuthUser, unauthorized, forbidden, requireRoleForRequest } from "@/lib/session";
import { getGoal } from "@/lib/goal-store";
import { runGoalRound } from "@/lib/goal-loop";

/**
 * POST /api/companies/:id/goals/:goalId/rounds — run the next round.
 *
 * Plans tasks for unmet criteria, executes the DAG, produces typed artifacts,
 * runs the evidence critic, and performs the CEO goal review. Returns the round
 * result (criteria delta, artifacts, summary). HUMAN GATE #2 is enforced in the
 * UI: a goal must be `active` or `awaiting_review` to run a round.
 */
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string; goalId: string }> }) {
  const user = await getAuthUser();
  if (!user) return unauthorized();
  const { id: companyId, goalId } = await params;
  const check = await requireRoleForRequest(user.id, "member", { companyId });
  if (!check.ok) return forbidden();

  const goal = await getGoal(goalId);
  if (!goal || goal.companyId !== companyId) {
    return NextResponse.json({ error: "Goal not found" }, { status: 404 });
  }
  if (goal.status === "round_running") {
    return NextResponse.json({ error: "A round is already running for this goal." }, { status: 409 });
  }
  if (goal.status === "completed" || goal.status === "stopped") {
    return NextResponse.json({ error: `Goal is ${goal.status}.` }, { status: 409 });
  }
  if (goal.status === "intake") {
    return NextResponse.json({ error: "Approve the success criteria before running a round." }, { status: 409 });
  }

  try {
    const result = await runGoalRound(goalId);
    const updated = await getGoal(goalId);
    return NextResponse.json({ result, goal: updated }, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      { error: "round_failed", detail: err instanceof Error ? err.message : "round failed" },
      { status: 500 },
    );
  }
}
