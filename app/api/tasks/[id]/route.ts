import { NextResponse } from "next/server";
import { store } from "@/lib/store";
import { getAuthUser, unauthorized, forbidden, requireRoleForRequest } from "@/lib/session";

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getAuthUser();
  if (!user) return unauthorized();

  const { id } = await params;
  const existing = await store.getTask(id);
  if (!existing) return NextResponse.json({ error: "Task not found" }, { status: 404 });

  const check = await requireRoleForRequest(user.id, "member", { entityType: "task", entityId: id });
  if (!check.ok) return forbidden();

  const task = await store.updateTask(id, await request.json());
  return NextResponse.json({ task });
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getAuthUser();
  if (!user) return unauthorized();

  const { id } = await params;
  const body = await request.json();
  const action = body.action as string;
  const task = await store.getTask(id);
  if (!task) return NextResponse.json({ error: "Task not found" }, { status: 404 });

  const check = await requireRoleForRequest(user.id, "member", { entityType: "task", entityId: id });
  if (!check.ok) return forbidden();

  if (action === "approve") return NextResponse.json({ task: await store.updateTask(id, { status: "queued" }) });
  if (action === "cancel") return NextResponse.json({ task: await store.updateTask(id, { status: "cancelled" }) });
  if (action === "retry") return NextResponse.json({ task: await store.updateTask(id, { status: "queued" }) });
  return NextResponse.json({ error: "Unsupported action" }, { status: 400 });
}

