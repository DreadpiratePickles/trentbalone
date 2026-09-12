import { NextResponse } from "next/server";
import { store } from "@/lib/store";
import { getAuthUser, unauthorized, forbidden, requireRoleForRequest } from "@/lib/session";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getAuthUser();
  if (!user) return unauthorized();

  const { id } = await params;
  const company = await store.getCompany(id);
  if (!company) return NextResponse.json({ error: "Company not found" }, { status: 404 });
  
  const check = await requireRoleForRequest(user.id, "viewer", { companyId: company.id });
  if (!check.ok) return forbidden();

  const query = new URL(request.url).searchParams.get("q") ?? "";
  return NextResponse.json({ results: await store.searchMemory(company.id, query) });
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getAuthUser();
  if (!user) return unauthorized();

  const { id } = await params;
  const company = await store.getCompany(id);
  if (!company) return NextResponse.json({ error: "Company not found" }, { status: 404 });
  
  const check = await requireRoleForRequest(user.id, "member", { companyId: company.id });
  if (!check.ok) return forbidden();

  const body = await request.clone().json().catch(() => ({}));
  const { docId, title, content } = body;
  if (!docId) return NextResponse.json({ error: "docId required" }, { status: 400 });

  const updated = await store.updateDocument(docId, { title, content });
  if (!updated) return NextResponse.json({ error: "Document not found" }, { status: 404 });
  return NextResponse.json({ document: updated });
}

