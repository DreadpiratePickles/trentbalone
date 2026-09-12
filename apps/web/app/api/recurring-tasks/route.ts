import { NextRequest, NextResponse } from "next/server";
import { store } from "@/lib/store";
import { requireRoleForRequest, forbidden, getAuthUser, unauthorized } from "@/lib/session";
import type { AgentRole } from "@/lib/types";

// GET /api/recurring-tasks?companyId=xxx — list recurring task templates
export async function GET(req: NextRequest) {
  const user = await getAuthUser();
  if (!user) return unauthorized();

  const companyId = req.nextUrl.searchParams.get("companyId");
  if (!companyId) return NextResponse.json({ error: "companyId required" }, { status: 400 });
  const check = await requireRoleForRequest(user.id, "viewer", { companyId });
  if (!check.ok) return forbidden();

  const templates = await store.listRecurringTasks(companyId);
  return NextResponse.json({ templates });
}

// POST /api/recurring-tasks — create a recurring task template
// Supports two modes:
//   1. fromTaskId: copy an existing task into a template
//   2. Full template definition in body
export async function POST(req: NextRequest) {
  const user = await getAuthUser();
  if (!user) return unauthorized();

  const body = await req.json() as {
    companyId: string;
    fromTaskId?: string;
    schedule?: "daily" | "weekly";
    title?: string;
    prompt?: string;
    agentRole?: AgentRole;
    priority?: string;
    tags?: string[];
    cadence?: "daily" | "weekly";
  };

  const { companyId, fromTaskId, schedule } = body;
  if (!companyId) return NextResponse.json({ error: "companyId required" }, { status: 400 });
  const check = await requireRoleForRequest(user.id, "admin", { companyId });
  if (!check.ok) return forbidden();

  // ── Mode 1: promote an existing task to a recurring template ──────────────
  if (fromTaskId) {
    const task = await store.getTask(fromTaskId);
    if (!task) return NextResponse.json({ error: "task not found" }, { status: 404 });
    if (task.companyId !== companyId) return forbidden();

    const cadence = (schedule ?? "weekly") as "daily" | "weekly";
    const now = new Date();
    // Next run: daily = tomorrow 09:00, weekly = next Monday 09:00
    const nextRunAt = cadence === "daily"
      ? new Date(now.setDate(now.getDate() + 1)).toISOString()
      : (() => {
        const d = new Date();
        const daysUntilMonday = ((1 - d.getDay()) + 7) % 7 || 7;
        d.setDate(d.getDate() + daysUntilMonday);
        d.setHours(9, 0, 0, 0);
        return d.toISOString();
      })();

    const template = await store.createRecurringTask({
      companyId,
      title: task.title,
      prompt: task.prompt,
      agentRole: task.agentRole,
      priority: task.priority,
      tags: [...(task.tags ?? []), "recurring", "from_chat"],
      cadence,
      enabled: true,
      nextRunAt,
    });

    return NextResponse.json({ template }, { status: 201 });
  }

  // ── Mode 2: create a new template from scratch ───────────────────────────
  const { title, prompt, agentRole, priority, tags, cadence } = body;
  if (!title || !prompt || !agentRole) {
    return NextResponse.json({ error: "title, prompt, and agentRole are required" }, { status: 400 });
  }

  const resolvedCadence = (cadence ?? schedule ?? "weekly") as "daily" | "weekly";
  const now = new Date();
  const nextRunAt = resolvedCadence === "daily"
    ? new Date(now.setDate(now.getDate() + 1)).toISOString()
    : (() => {
      const d = new Date();
      const daysUntilMonday = ((1 - d.getDay()) + 7) % 7 || 7;
      d.setDate(d.getDate() + daysUntilMonday);
      d.setHours(9, 0, 0, 0);
      return d.toISOString();
    })();

  const template = await store.createRecurringTask({
    companyId,
    title,
    prompt,
    agentRole,
    priority: (priority ?? "medium") as "low" | "medium" | "high" | "urgent",
    tags: tags ?? [],
    cadence: resolvedCadence,
    enabled: true,
    nextRunAt,
  });

  return NextResponse.json({ template }, { status: 201 });
}

// PATCH /api/recurring-tasks — update a recurring template (enable/disable)
export async function PATCH(req: NextRequest) {
  const user = await getAuthUser();
  if (!user) return unauthorized();

  const body = await req.json() as { id: string; enabled?: boolean; cadence?: "daily" | "weekly" };
  const { id, ...patch } = body;
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  const template = await store.getRecurringTask(id);
  if (!template) return NextResponse.json({ error: "template not found" }, { status: 404 });
  const check = await requireRoleForRequest(user.id, "admin", { entityType: "recurring-task", entityId: id });
  if (!check.ok) return forbidden();

  const updated = await store.updateRecurringTask(id, patch);
  if (!updated) return NextResponse.json({ error: "update failed" }, { status: 500 });

  return NextResponse.json({ template: updated });
}

// DELETE /api/recurring-tasks?id=xxx — delete a template
export async function DELETE(req: NextRequest) {
  const user = await getAuthUser();
  if (!user) return unauthorized();

  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  const template = await store.getRecurringTask(id);
  if (!template) return NextResponse.json({ error: "template not found" }, { status: 404 });
  const check = await requireRoleForRequest(user.id, "admin", { entityType: "recurring-task", entityId: id });
  if (!check.ok) return forbidden();

  await store.deleteRecurringTask(id);
  return NextResponse.json({ ok: true });
}
