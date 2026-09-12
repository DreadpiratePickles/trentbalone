import { NextResponse } from "next/server";
import { enqueueRecurringTaskMaterialization, enqueueScheduledCycleSweep } from "@/lib/queue";
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

  const recurringTasks = await store.listRecurringTasks(company.id);
  return NextResponse.json({
    cycleFrequency: company.cycleFrequency,
    lastCycleAt: company.lastCycleAt,
    nextCycleAt: company.nextCycleAt,
    recurringTasks
  });
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getAuthUser();
  if (!user) return unauthorized();

  const { id } = await params;
  const company = await store.getCompany(id);
  if (!company) return NextResponse.json({ error: "Company not found" }, { status: 404 });
  
  const check = await requireRoleForRequest(user.id, "admin", { companyId: company.id });
  if (!check.ok) return forbidden();

  const body = await request.clone().json().catch(() => ({}));
  if (!["manual", "daily", "weekly"].includes(body.cycleFrequency)) {
    return NextResponse.json({ error: "cycleFrequency must be manual, daily, or weekly" }, { status: 400 });
  }
  const [updated, recurringTasks] = await Promise.all([
    store.updateCompany(company.id, {
      cycleFrequency: body.cycleFrequency,
      nextCycleAt: store.nextCycleAt(body.cycleFrequency)
    }),
    store.listRecurringTasks(company.id)
  ]);
  return NextResponse.json({ company: updated, recurringTasks });
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
  const { action } = body;

  if (action === "run_due_cycles") {
    return NextResponse.json({ job: await enqueueScheduledCycleSweep("user", [company.id]) }, { status: 201 });
  }

  if (action === "create_template") {
    const { title, prompt, agentRole, cadence, priority } = body;
    if (!title || !agentRole || !cadence) {
      return NextResponse.json({ error: "title, agentRole, cadence required" }, { status: 400 });
    }
    const now = new Date();
    const nextRunAt = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
    const template = await store.createRecurringTask({
      companyId: company.id,
      title,
      prompt: prompt || title,
      agentRole,
      cadence,
      priority: priority ?? "medium",
      tags: [],
      enabled: true,
      lastMaterializedAt: undefined,
      nextRunAt,
    });
    return NextResponse.json({ template }, { status: 201 });
  }

  if (action === "toggle_template") {
    const { templateId } = body;
    if (!templateId) return NextResponse.json({ error: "templateId required" }, { status: 400 });
    const templates = await store.listRecurringTasks(company.id);
    const t = templates.find((x) => x.id === templateId);
    if (!t) return NextResponse.json({ error: "Template not found" }, { status: 404 });
    const updated = await store.updateRecurringTask(templateId, { enabled: !t.enabled });
    return NextResponse.json({ template: updated });
  }

  if (action === "delete_template") {
    const { templateId } = body;
    if (!templateId) return NextResponse.json({ error: "templateId required" }, { status: 400 });
    await store.deleteRecurringTask(templateId);
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ job: await enqueueRecurringTaskMaterialization(company.id, "user") }, { status: 201 });
}


