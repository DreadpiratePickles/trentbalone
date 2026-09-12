import { NextRequest, NextResponse } from "next/server";
import { getAuthUser, unauthorized, forbidden, requireRoleForRequest } from "@/lib/session";
import { deleteCustomSkill, updateCustomSkill } from "@/lib/custom-skill-store";

/** PATCH /api/companies/:id/skills/:skillId — edit a custom skill. */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; skillId: string }> },
) {
  const user = await getAuthUser();
  if (!user) return unauthorized();
  const { id: companyId, skillId } = await params;
  const check = await requireRoleForRequest(user.id, "member", { companyId });
  if (!check.ok) return forbidden();

  const body = (await request.json().catch(() => ({}))) as {
    name?: string;
    trigger?: string;
    instructions?: string;
    enabled?: boolean;
  };
  const patch: Record<string, string | boolean> = {};
  if (typeof body.name === "string" && body.name.trim()) patch.name = body.name.trim();
  if (typeof body.trigger === "string") patch.trigger = body.trigger.trim();
  if (typeof body.instructions === "string" && body.instructions.trim()) patch.instructions = body.instructions.trim();
  if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "no valid fields to update" }, { status: 400 });
  }

  const skill = await updateCustomSkill(companyId, skillId, patch);
  if (!skill) return NextResponse.json({ error: "Skill not found" }, { status: 404 });
  return NextResponse.json({ skill });
}

/** DELETE /api/companies/:id/skills/:skillId — remove a custom skill. */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; skillId: string }> },
) {
  const user = await getAuthUser();
  if (!user) return unauthorized();
  const { id: companyId, skillId } = await params;
  const check = await requireRoleForRequest(user.id, "member", { companyId });
  if (!check.ok) return forbidden();

  const removed = await deleteCustomSkill(companyId, skillId);
  if (!removed) return NextResponse.json({ error: "Skill not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
