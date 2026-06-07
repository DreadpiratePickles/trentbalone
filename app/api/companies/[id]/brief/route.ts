import { NextResponse } from "next/server";
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

  return NextResponse.json({ brief: company.brief });
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getAuthUser();
  if (!user) return unauthorized();

  const { id } = await params;
  const company = await store.getCompany(id);
  if (!company) return NextResponse.json({ error: "Company not found" }, { status: 404 });
  
  const check = await requireRoleForRequest(user.id, "admin", { companyId: company.id });
  if (!check.ok) return forbidden();

  const body = await request.clone().json().catch(() => ({}));
  const updated = await store.updateCompany(company.id, { brief: { ...company.brief, ...body } });
  return NextResponse.json({ brief: updated?.brief });
}

