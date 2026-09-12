import { NextRequest, NextResponse } from "next/server";
import { getAuthUser, unauthorized, forbidden, requireRoleForRequest } from "@/lib/session";
import { createCustomSkill, listCustomSkills } from "@/lib/custom-skill-store";

/** GET /api/companies/:id/skills — list client-authored custom skills (§3.2). */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getAuthUser();
  if (!user) return unauthorized();
  const { id: companyId } = await params;
  const check = await requireRoleForRequest(user.id, "viewer", { companyId });
  if (!check.ok) return forbidden();
  return NextResponse.json({ skills: await listCustomSkills(companyId) });
}

/** POST /api/companies/:id/skills — author a new instruction-style skill. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getAuthUser();
  if (!user) return unauthorized();
  const { id: companyId } = await params;
  const check = await requireRoleForRequest(user.id, "member", { companyId });
  if (!check.ok) return forbidden();

  const body = (await request.json().catch(() => ({}))) as {
    name?: string;
    trigger?: string;
    instructions?: string;
    enabled?: boolean;
  };
  const name = body.name?.trim();
  const instructions = body.instructions?.trim();
  if (!name || !instructions) {
    return NextResponse.json({ error: "name and instructions are required" }, { status: 400 });
  }

  const skill = await createCustomSkill({
    companyId,
    name,
    trigger: body.trigger?.trim() ?? "",
    instructions,
    enabled: body.enabled ?? true,
  });
  return NextResponse.json({ skill }, { status: 201 });
}
