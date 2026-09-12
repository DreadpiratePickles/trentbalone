import { NextResponse } from "next/server";
import { sendGmailDraftForTask } from "@/lib/gmail";
import { store } from "@/lib/store";
import { requireRoleForRequest, forbidden, getAuthUser, unauthorized } from "@/lib/session";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getAuthUser();
  if (!user) return unauthorized();

  const { id } = await params;
  const task = await store.getTask(id);
  if (!task) return NextResponse.json({ error: "Task not found" }, { status: 404 });
  
  const check = await requireRoleForRequest(user.id, "member", { entityType: "task", entityId: id });
  if (!check.ok) return forbidden();


  if (!["queued", "running", "waiting_approval"].includes(task.status)) {
    return NextResponse.json(
      { error: "Task must be queued, running, or waiting for approval before Gmail send" },
      { status: 409 }
    );
  }

  const result = await sendGmailDraftForTask(task);
  return NextResponse.json(
    { result },
    { status: result.status === "needs_approval" ? 202 : 200 }
  );
}
