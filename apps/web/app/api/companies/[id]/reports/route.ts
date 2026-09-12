import { NextResponse } from "next/server";
import { createWeeklyReport, assembleMorningBriefing } from "@/lib/scheduler";
import { store } from "@/lib/store";
import { getAuthUser, unauthorized, forbidden, requireRoleForRequest } from "@/lib/session";

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getAuthUser();
  if (!user) return unauthorized();

  const { id } = await params;
  const company = await store.getCompany(id);
  if (!company) return NextResponse.json({ error: "Company not found" }, { status: 404 });
  
  const check = await requireRoleForRequest(user.id, "viewer", { companyId: company.id });
  if (!check.ok) return forbidden();

  const [reports, documents] = await Promise.all([
    store.listReports(company.id),
    store.listDocuments(company.id)
  ]);
  return NextResponse.json({ reports, documents });
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getAuthUser();
  if (!user) return unauthorized();

  const { id } = await params;
  const company = await store.getCompany(id);
  if (!company) return NextResponse.json({ error: "Company not found" }, { status: 404 });
  
  const check = await requireRoleForRequest(user.id, "member", { companyId: company.id });
  if (!check.ok) return forbidden();

  const action = (await request.clone().json().catch(() => ({}))).action;
  if (action === "weekly") {
    return NextResponse.json({ report: await createWeeklyReport(company.id) }, { status: 201 });
  }
  if (action === "morning_briefing") {
    return NextResponse.json({ report: await assembleMorningBriefing(company.id) }, { status: 201 });
  }
  return NextResponse.json({ error: "Unknown report action" }, { status: 400 });
}

