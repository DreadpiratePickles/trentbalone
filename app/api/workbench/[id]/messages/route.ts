import { NextResponse } from "next/server";
import { forbidden, getAuthUser, unauthorized, requireRoleForRequest } from "@/lib/session";
import { store } from "@/lib/store";
import { withRlsContext } from "@/lib/with-rls";
import { runWorkbenchAgent } from "@/lib/workbench-agent";
import { ensureWorkbenchSandboxReady } from "@/lib/workbench-orchestrator";

/** GET /api/workbench/:id/messages — list the chat transcript for a session. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getAuthUser();
  if (!user) return unauthorized();

  const { id } = await params;
  const session = await store.getWorkbenchSession(id);
  if (!session) return NextResponse.json({ error: "workbench session not found" }, { status: 404 });

  const check = await requireRoleForRequest(user.id, "viewer", { companyId: session.companyId });
  if (!check.ok) return forbidden();

  const messages = await withRlsContext(session.companyId, () => store.listWorkbenchChatMessages(id));
  return NextResponse.json({ messages });
}

/**
 * POST /api/workbench/:id/messages — send a message and stream the autonomous agent's
 * progress back as Server-Sent Events. Each `data:` line is a JSON `WorkbenchAgentChunk`;
 * the stream ends with `data: [DONE]`.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getAuthUser();
  if (!user) return unauthorized();

  const { id } = await params;
  const session = await store.getWorkbenchSession(id);
  if (!session) return NextResponse.json({ error: "workbench session not found" }, { status: 404 });

  const check = await requireRoleForRequest(user.id, "member", { companyId: session.companyId });
  if (!check.ok) return forbidden();

  const body = (await request.json().catch(() => ({}))) as { content?: string };
  const content = body.content?.trim();
  if (!content) return NextResponse.json({ error: "content is required" }, { status: 400 });

  const history = await withRlsContext(session.companyId, () => store.listWorkbenchChatMessages(id));
  // NOTE: stream body runs after handler returns; store calls inside it rely on app-level companyId scoping (RLS context cannot span the stream).

  // Ensure the sandbox provider is alive in this process. A container restart
  // clears the in-memory sandboxes Map, so we restore from the persisted
  // providerSessionId before handing off to the agent.
  try {
    await ensureWorkbenchSandboxReady(session);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Sandbox initialisation failed";
    return NextResponse.json({ error: message }, { status: 503 });
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (data: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      try {
        for await (const chunk of runWorkbenchAgent({ session, userMessage: content, history })) {
          send(chunk);
        }
      } catch (err) {
        send({ type: "error", message: err instanceof Error ? err.message : "agent failed" });
      } finally {
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
