import { NextRequest, NextResponse } from "next/server";
import { forbidden, getAuthUser, requireRoleForRequest, unauthorized } from "@/lib/session";
import {
  listWikiNotes,
  getWikiNote,
  createOrUpdateWikiNote,
  deleteWikiNote,
  buildWikiTree,
  buildGraph,
} from "@/lib/wiki-notes";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getAuthUser();
  if (!user) return unauthorized();
  const { id: companyId } = await params;
  const check = await requireRoleForRequest(user.id, "viewer", { companyId });
  if (!check.ok) return forbidden();

  const url = new URL(request.url);
  const view = url.searchParams.get("view") ?? "all";
  const noteId = url.searchParams.get("note");

  if (noteId) {
    const note = await getWikiNote(companyId, noteId);
    if (!note) return NextResponse.json({ error: "note not found" }, { status: 404 });
    return NextResponse.json({ note });
  }
  if (view === "graph") {
    return NextResponse.json({ graph: await buildGraph(companyId) });
  }

  const [notes, tree] = await Promise.all([
    listWikiNotes(companyId),
    buildWikiTree(companyId),
  ]);
  return NextResponse.json({ notes, tree });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getAuthUser();
  if (!user) return unauthorized();
  const { id: companyId } = await params;
  const check = await requireRoleForRequest(user.id, "member", { companyId });
  if (!check.ok) return forbidden();

  const body = (await request.json().catch(() => ({}))) as {
    id?: string;
    path?: string;
    title?: string;
    content?: string;
  };
  if (!body.title?.trim()) return NextResponse.json({ error: "title required" }, { status: 400 });

  const note = await createOrUpdateWikiNote({
    companyId,
    id: body.id,
    path: body.path ?? `/${body.title}`,
    title: body.title.trim(),
    content: body.content ?? "",
  });
  return NextResponse.json({ note });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getAuthUser();
  if (!user) return unauthorized();
  const { id: companyId } = await params;
  const check = await requireRoleForRequest(user.id, "member", { companyId });
  if (!check.ok) return forbidden();

  const noteId = new URL(request.url).searchParams.get("note");
  if (!noteId) return NextResponse.json({ error: "note id required" }, { status: 400 });

  const ok = await deleteWikiNote(companyId, noteId);
  return NextResponse.json({ deleted: ok });
}
