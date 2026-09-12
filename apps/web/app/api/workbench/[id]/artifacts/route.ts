import { NextResponse } from "next/server";
import { forbidden, getAuthUser, unauthorized, requireRoleForRequest } from "@/lib/session";
import { store } from "@/lib/store";
import { withRlsContext } from "@/lib/with-rls";
import { getWorkbenchProvider } from "@/lib/workbench-provider";
import "@/lib/workbench-providers";
import type { WorkbenchArtifact, WorkbenchArtifactKind } from "@/lib/types";

const artifactKinds: WorkbenchArtifactKind[] = ["file", "screenshot", "terminal_log", "test_result", "preview", "export"];

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getAuthUser();
  if (!user) return unauthorized();

  const { id } = await params;
  const session = await store.getWorkbenchSession(id);
  if (!session) return NextResponse.json({ error: "workbench session not found" }, { status: 404 });

  const check = await requireRoleForRequest(user.id, "member", { companyId: session.companyId });
  if (!check.ok) return forbidden();

  const body = await request.json() as {
    title?: string;
    kind?: WorkbenchArtifactKind;
    mimeType?: string;
    content?: string;
    sizeBytes?: number;
    createdByAgent?: WorkbenchArtifact["createdByAgent"];
    sourceEventId?: string;
    path?: string;
    previewUrl?: string;
    metadata?: WorkbenchArtifact["metadata"];
  };

  if (!body.title?.trim()) {
    return NextResponse.json({ error: "title is required" }, { status: 400 });
  }
  if (body.kind && !artifactKinds.includes(body.kind)) {
    return NextResponse.json({ error: "Unsupported artifact kind" }, { status: 400 });
  }

  const provider = getWorkbenchProvider(session.provider);
  const title = body.title.trim();
  const { artifact, event } = await withRlsContext(session.companyId, () => provider.captureArtifact(session, {
    title,
    kind: body.kind ?? "terminal_log",
    mimeType: body.mimeType,
    content: body.content,
    sizeBytes: body.sizeBytes,
    createdByAgent: body.createdByAgent,
    sourceEventId: body.sourceEventId,
    path: body.path,
    previewUrl: body.previewUrl,
    metadata: body.metadata
  }));

  return NextResponse.json({ artifact, event }, { status: 201 });
}
