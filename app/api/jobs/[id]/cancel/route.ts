import { NextResponse } from "next/server";
import { cancelJobRun } from "@/lib/queue";
import { store } from "@/lib/store";
import { forbidden, getAuthUser, requireRoleForRequest, unauthorized } from "@/lib/session";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getAuthUser();
  if (!user) return unauthorized();

  const { id } = await params;
  const jobRun = await store.getJobRun(id);
  if (!jobRun || !jobRun.companyId) return NextResponse.json({ error: "Job not found" }, { status: 404 });

  const check = await requireRoleForRequest(user.id, "admin", { companyId: jobRun.companyId });
  if (!check.ok) return forbidden();

  const cancelled = await cancelJobRun(id);
  return NextResponse.json({ jobRun: cancelled });
}
