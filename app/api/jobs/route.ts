import { NextResponse } from "next/server";
import { store } from "@/lib/store";
import { forbidden, getAuthUser, requireRoleForRequest, unauthorized } from "@/lib/session";

export async function GET(request: Request) {
  const user = await getAuthUser();
  if (!user) return unauthorized();

  const companyId = new URL(request.url).searchParams.get("companyId");
  if (!companyId) {
    return NextResponse.json({ error: "companyId is required" }, { status: 400 });
  }

  const check = await requireRoleForRequest(user.id, "viewer", { companyId });
  if (!check.ok) return forbidden();

  const jobRuns = await store.listJobRuns(companyId);
  return NextResponse.json({ jobRuns });
}
