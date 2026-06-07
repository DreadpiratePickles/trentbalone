import { NextResponse } from "next/server";
import { forbidden, getAuthUser, requireRoleForRequest, unauthorized } from "@/lib/session";
import { store } from "@/lib/store";
import type { ArtifactStatus } from "@/lib/types";

const statuses: ArtifactStatus[] = ["draft", "ready", "needs_approval", "approved", "sent", "failed"];

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getAuthUser();
  if (!user) return unauthorized();

  const { id } = await params;
  const artifact = await store.getArtifact(id);
  if (!artifact) return NextResponse.json({ error: "artifact not found" }, { status: 404 });

  const check = await requireRoleForRequest(user.id, "viewer", { companyId: artifact.companyId });
  if (!check.ok) return forbidden();

  return NextResponse.json({ artifact });
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getAuthUser();
  if (!user) return unauthorized();

  const { id } = await params;
  const existing = await store.getArtifact(id);
  if (!existing) return NextResponse.json({ error: "artifact not found" }, { status: 404 });

  const check = await requireRoleForRequest(user.id, "member", { companyId: existing.companyId });
  if (!check.ok) return forbidden();

  const body = await request.json() as {
    status?: ArtifactStatus;
    title?: string;
    summary?: string;
    content?: string;
  };

  if (body.status && !statuses.includes(body.status)) {
    return NextResponse.json({ error: "Unsupported artifact status" }, { status: 400 });
  }

  const artifact = await store.updateArtifact(id, {
    status: body.status,
    title: body.title,
    summary: body.summary,
    content: body.content,
    approvalStatus: body.status === "approved" ? "approved" : existing.approvalStatus
  });

  return NextResponse.json({ artifact });
}
