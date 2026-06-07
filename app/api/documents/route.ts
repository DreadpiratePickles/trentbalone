import { NextResponse } from "next/server";
import { store } from "@/lib/store";
import { getAuthUser, unauthorized, forbidden, requireRoleForRequest } from "@/lib/session";
import { filterActiveDocuments } from "@/lib/active-documents";
import type { Document, DocumentMemoryTier } from "@/lib/types";

const documentTypes: Document["type"][] = [
  "brief",
  "roadmap",
  "marketing_plan",
  "research",
  "support_summary",
  "weekly_report",
  "agent_note",
  "feature_gap",
  "email_draft",
];

const memoryTiers: DocumentMemoryTier[] = ["working", "episodic", "semantic"];

export async function GET(request: Request) {
  const user = await getAuthUser();
  if (!user) return unauthorized();

  const companyId = new URL(request.url).searchParams.get("companyId");
  if (!companyId) {
    return NextResponse.json({ error: "companyId is required" }, { status: 400 });
  }

  const check = await requireRoleForRequest(user.id, "viewer", { companyId });
  if (!check.ok) return forbidden();

  const documents = await store.listDocuments(companyId);
  return NextResponse.json({ documents: filterActiveDocuments(documents) });
}

export async function POST(request: Request) {
  const user = await getAuthUser();
  if (!user) return unauthorized();

  const body = await request.json();
  if (!body.companyId || !body.title || !body.content) {
    return NextResponse.json({ error: "companyId, title, and content are required" }, { status: 400 });
  }

  const type = body.type ?? "agent_note";
  if (!documentTypes.includes(type)) {
    return NextResponse.json({ error: "Unsupported document type" }, { status: 400 });
  }
  const memoryTier = body.memoryTier;
  if (memoryTier !== undefined && !memoryTiers.includes(memoryTier)) {
    return NextResponse.json({ error: "Unsupported memory tier" }, { status: 400 });
  }

  const check = await requireRoleForRequest(user.id, "member", { companyId: body.companyId });
  if (!check.ok) return forbidden();

  return NextResponse.json(
    {
      document: await store.createDocument({
        companyId: body.companyId,
        type,
        title: body.title,
        content: body.content,
        source: body.source ?? "user",
        memoryTier,
      })
    },
    { status: 201 }
  );
}
