import { NextResponse } from "next/server";
import { forbidden, getAuthUser, unauthorized, requireRoleForRequest } from "@/lib/session";
import { store } from "@/lib/store";
import { withRlsContext } from "@/lib/with-rls";
import { captureWorkbenchArtifact } from "@/lib/workbench";
import { enqueueWikiIndexRefresh } from "@/lib/queue";
import { shouldReindexFromWorkbenchEvent } from "@/lib/trench-wiki";
import type { WorkbenchArtifactKind, WorkbenchEventStatus, WorkbenchEventType } from "@/lib/types";

const eventTypes: WorkbenchEventType[] = ["plan", "shell", "browser", "file", "test", "screenshot", "artifact", "deploy", "approval", "system"];
const eventStatuses: WorkbenchEventStatus[] = ["pending", "running", "completed", "failed", "needs_approval"];
const artifactKinds: WorkbenchArtifactKind[] = ["file", "screenshot", "terminal_log", "test_result", "preview", "export"];

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getAuthUser();
  if (!user) return unauthorized();

  const { id } = await params;
  const session = await store.getWorkbenchSession(id);
  if (!session) return NextResponse.json({ error: "workbench session not found" }, { status: 404 });

  const check = await requireRoleForRequest(user.id, "viewer", { companyId: session.companyId });
  if (!check.ok) return forbidden();

  const [events, artifacts] = await withRlsContext(session.companyId, () => Promise.all([
    store.listWorkbenchEvents(id),
    store.listWorkbenchArtifacts(id)
  ]));
  return NextResponse.json({ events, artifacts });
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getAuthUser();
  if (!user) return unauthorized();

  const { id } = await params;
  const session = await store.getWorkbenchSession(id);
  if (!session) return NextResponse.json({ error: "workbench session not found" }, { status: 404 });

  const check = await requireRoleForRequest(user.id, "member", { companyId: session.companyId });
  if (!check.ok) return forbidden();

  const body = await request.json() as {
    type?: WorkbenchEventType;
    status?: WorkbenchEventStatus;
    title?: string;
    content?: string;
    command?: string;
    captureArtifact?: {
      title: string;
      kind?: WorkbenchArtifactKind;
      mimeType?: string;
      sizeBytes?: number;
    };
  };

  if (!body.type || !eventTypes.includes(body.type)) {
    return NextResponse.json({ error: "Unsupported event type" }, { status: 400 });
  }
  if (!body.status || !eventStatuses.includes(body.status)) {
    return NextResponse.json({ error: "Unsupported event status" }, { status: 400 });
  }
  if (!body.title?.trim() || !body.content?.trim()) {
    return NextResponse.json({ error: "title and content are required" }, { status: 400 });
  }
  if (body.captureArtifact?.kind && !artifactKinds.includes(body.captureArtifact.kind)) {
    return NextResponse.json({ error: "Unsupported artifact kind" }, { status: 400 });
  }

  // Hoist narrowed body fields before entering the closure (preserves TS narrowing).
  const eventType = body.type;
  const eventStatus = body.status;
  const eventTitle = body.title.trim();
  const eventContent = body.content.trim();

  const { event, artifact } = await withRlsContext(session.companyId, async () => {
    const captured = body.captureArtifact
      ? await captureWorkbenchArtifact({
          companyId: session.companyId,
          sessionId: session.id,
          title: body.captureArtifact.title,
          kind: body.captureArtifact.kind,
          mimeType: body.captureArtifact.mimeType,
          sizeBytes: body.captureArtifact.sizeBytes
        })
      : undefined;

    const evt = await store.addWorkbenchEvent({
      companyId: session.companyId,
      sessionId: session.id,
      type: eventType,
      status: eventStatus,
      title: eventTitle,
      content: eventContent,
      command: body.command,
      artifactId: captured?.id
    });

    return { event: evt, artifact: captured };
  });

  if (shouldReindexFromWorkbenchEvent(event)) {
    await enqueueWikiIndexRefresh(session.companyId, "system", session.id).catch((error: unknown) => {
      console.error("Failed to enqueue Trench Wiki refresh:", error);
    });
  }

  return NextResponse.json({ event, artifact }, { status: 201 });
}
