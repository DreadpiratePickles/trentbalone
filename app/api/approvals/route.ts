import { NextResponse } from "next/server";
import { store } from "@/lib/store";
import { getAuthUser, unauthorized, forbidden, requireRoleForRequest } from "@/lib/session";

export async function GET(request: Request) {
  const user = await getAuthUser();
  if (!user) return unauthorized();

  const companyId = new URL(request.url).searchParams.get("companyId");
  if (!companyId) {
    return NextResponse.json({ error: "companyId is required" }, { status: 400 });
  }

  const check = await requireRoleForRequest(user.id, "viewer", { companyId });
  if (!check.ok) return forbidden();

  return NextResponse.json({ approvals: await store.listApprovals(companyId) });
}

export async function POST(request: Request) {
  const user = await getAuthUser();
  if (!user) return unauthorized();

  const body = await request.json();
  if (!body.companyId || !body.action || !body.reason) {
    return NextResponse.json({ error: "companyId, action, and reason are required" }, { status: 400 });
  }

  const check = await requireRoleForRequest(user.id, "member", { companyId: body.companyId });
  if (!check.ok) return forbidden();

  return NextResponse.json({ approval: await store.createApproval(body) }, { status: 201 });
}
