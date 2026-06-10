import { NextRequest, NextResponse } from "next/server";
import { store } from "@/lib/store";
import { getAuthUser, unauthorized, forbidden, requireRoleForRequest } from "@/lib/session";
import { runGoalIntake } from "@/lib/goal-intake";
import { createGoal, listGoals } from "@/lib/goal-store";
import { makeId } from "@/lib/utils";
import { goalConstraintsSchema, type SuccessCriterion } from "@/lib/goal-types";

/** GET /api/companies/:id/goals — list goals for the company. */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getAuthUser();
  if (!user) return unauthorized();
  const { id: companyId } = await params;
  const check = await requireRoleForRequest(user.id, "viewer", { companyId });
  if (!check.ok) return forbidden();
  return NextResponse.json({ goals: await listGoals(companyId) });
}

/**
 * POST /api/companies/:id/goals — CEO intake.
 * Body: { command: string, constraints?: {...} }.
 * Runs intake → returns a goal in `intake` status with proposed measurable
 * criteria for the founder to approve at HUMAN GATE #1.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getAuthUser();
  if (!user) return unauthorized();
  const { id: companyId } = await params;
  const check = await requireRoleForRequest(user.id, "member", { companyId });
  if (!check.ok) return forbidden();

  const company = await store.getCompany(companyId);
  if (!company) return NextResponse.json({ error: "Company not found" }, { status: 404 });

  const body = (await request.json().catch(() => ({}))) as { command?: string; constraints?: unknown };
  const command = body.command?.trim();
  if (!command) return NextResponse.json({ error: "command required" }, { status: 400 });

  let intake;
  try {
    intake = await runGoalIntake(company, command);
  } catch (err) {
    return NextResponse.json(
      { error: "intake_failed", detail: err instanceof Error ? err.message : "intake failed" },
      { status: 502 },
    );
  }

  const successCriteria: SuccessCriterion[] = intake.successCriteria.map((c) => ({
    id: makeId("crit"),
    text: c.text,
    status: "unmet",
    evidenceArtifactIds: [],
  }));
  const constraints = goalConstraintsSchema.parse({
    ...(typeof body.constraints === "object" && body.constraints ? body.constraints : {}),
    budgetCentsCap: (body.constraints as { budgetCentsCap?: number })?.budgetCentsCap ?? Math.max(intake.budgetEstimateCents, 1000),
  });

  const goal = await createGoal({
    companyId,
    objective: intake.objective,
    successCriteria,
    constraints,
    status: "intake",
  });

  return NextResponse.json({ goal, rationale: intake.rationale }, { status: 201 });
}
