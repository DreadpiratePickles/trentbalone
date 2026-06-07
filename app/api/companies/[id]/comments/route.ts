import { NextRequest, NextResponse } from "next/server";
import { store } from "@/lib/store";
import { forbidden, getAuthUser, requireRoleForRequest, unauthorized } from "@/lib/session";
import type { CommentEntityType } from "@/lib/types";

const ENTITY_TYPES: CommentEntityType[] = ["approval", "task", "artifact", "cycle", "report"];

// GET /api/companies/[id]/comments?entityType=approval&entityId=xxx
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await getAuthUser();
  if (!user) return unauthorized();

  const { id: companyId } = await params;
  const company = await store.getCompany(companyId);
  if (!company) return NextResponse.json({ error: "Company not found" }, { status: 404 });

  const check = await requireRoleForRequest(user.id, "viewer", { companyId });
  if (!check.ok) return forbidden();

  const entityType = req.nextUrl.searchParams.get("entityType") as CommentEntityType | null;
  const entityId = req.nextUrl.searchParams.get("entityId");

  if (!entityType || !ENTITY_TYPES.includes(entityType)) {
    return NextResponse.json({ error: "entityType required (approval|task|artifact|cycle|report)" }, { status: 400 });
  }
  if (!entityId) {
    return NextResponse.json({ error: "entityId required" }, { status: 400 });
  }

  const comments = await store.listComments(companyId, entityType, entityId);
  return NextResponse.json({ comments });
}

// POST /api/companies/[id]/comments
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await getAuthUser();
  if (!user) return unauthorized();

  const { id: companyId } = await params;
  const company = await store.getCompany(companyId);
  if (!company) return NextResponse.json({ error: "Company not found" }, { status: 404 });

  const check = await requireRoleForRequest(user.id, "member", { companyId });
  if (!check.ok) return forbidden();

  const body = await req.clone().json().catch(() => ({})) as {
    entityType: CommentEntityType;
    entityId: string;
    content: string;
    agentRole?: string;
  };

  if (!body.entityType || !ENTITY_TYPES.includes(body.entityType)) {
    return NextResponse.json({ error: "entityType required" }, { status: 400 });
  }
  if (!body.entityId) return NextResponse.json({ error: "entityId required" }, { status: 400 });
  if (!body.content?.trim()) return NextResponse.json({ error: "content required" }, { status: 400 });

  const authorName = body.agentRole
    ? body.agentRole.charAt(0).toUpperCase() + body.agentRole.slice(1) + " Agent"
    : (user.name ?? user.email ?? "You");

  const comment = await store.addComment({
    companyId,
    entityType: body.entityType,
    entityId: body.entityId,
    authorName,
    agentRole: body.agentRole,
    content: body.content.trim(),
  });

  return NextResponse.json({ comment }, { status: 201 });
}

