import { NextResponse } from "next/server";
import { store } from "@/lib/store";
import { getAuthUser, unauthorized, forbidden, requireRoleForRequest } from "@/lib/session";
import { checkRateLimit, rateLimitExceeded } from "@/lib/rate-limit";

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getAuthUser();
  if (!user) return unauthorized();

  const { id } = await params;
  const company = await store.getCompany(id);
  if (!company) return NextResponse.json({ error: "Company not found" }, { status: 404 });

  const check = await requireRoleForRequest(user.id, "viewer", { companyId: company.id });
  if (!check.ok) return forbidden();

  const rateLimit = await checkRateLimit(user.id, company.id);
  if (!rateLimit.ok) return rateLimitExceeded(rateLimit.retryAfterSeconds);

  const [agents, tasks, recurringTasks, cycles, executions, approvals, documents, reports, usage, integrations] =
    await Promise.all([
      store.listAgents(company.id),
      store.listTasks(company.id),
      store.listRecurringTasks(company.id),
      store.listCycles(company.id),
      store.listExecutions(company.id),
      store.listApprovals(company.id),
      store.listDocuments(company.id),
      store.listReports(company.id),
      store.listUsage(company.id),
      store.listIntegrations(company.id)
    ]);
  return NextResponse.json({ company, agents, tasks, recurringTasks, cycles, executions, approvals, documents, reports, usage, integrations });
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getAuthUser();
  if (!user) return unauthorized();

  const { id } = await params;
  const company = await store.getCompany(id);
  if (!company) return NextResponse.json({ error: "Company not found" }, { status: 404 });
  
  const check = await requireRoleForRequest(user.id, "admin", { companyId: company.id });
  if (!check.ok) return forbidden();

  const rateLimit = await checkRateLimit(user.id, company.id);
  if (!rateLimit.ok) return rateLimitExceeded(rateLimit.retryAfterSeconds);

  const updated = await store.updateCompany(company.id, await request.json());
  return NextResponse.json({ company: updated });
}

export async function DELETE(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getAuthUser();
  if (!user) return unauthorized();

  const { id } = await params;
  const company = await store.getCompany(id);
  if (!company) return NextResponse.json({ error: "Company not found" }, { status: 404 });
  
  const check = await requireRoleForRequest(user.id, "admin", { companyId: company.id });
  if (!check.ok) return forbidden();

  const rateLimit = await checkRateLimit(user.id, company.id);
  if (!rateLimit.ok) return rateLimitExceeded(rateLimit.retryAfterSeconds);

  const updated = await store.updateCompany(company.id, { status: "archived" });
  return NextResponse.json({ company: updated });
}

