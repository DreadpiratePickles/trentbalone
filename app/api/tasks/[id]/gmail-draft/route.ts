import { NextResponse } from "next/server";
import { createGmailDraftForTask } from "@/lib/gmail";
import { store } from "@/lib/store";
import { requireRoleForRequest, forbidden, getAuthUser, unauthorized } from "@/lib/session";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getAuthUser();
  if (!user) return unauthorized();

  const { id } = await params;
  const task = await store.getTask(id);
  if (!task) return NextResponse.json({ error: "Task not found" }, { status: 404 });
  
  const check = await requireRoleForRequest(user.id, "member", { entityType: "task", entityId: id });
  if (!check.ok) return forbidden();


  const body = await request.json().catch(() => ({}));
  const document = await createGmailDraftForTask(task, {
    to: typeof body.to === "string" ? body.to : undefined,
    subject: typeof body.subject === "string" ? body.subject : undefined,
    body: typeof body.body === "string" ? body.body : undefined
  });

  return NextResponse.json({ document }, { status: 201 });
}
