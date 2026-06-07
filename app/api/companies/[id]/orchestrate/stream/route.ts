import { NextRequest } from "next/server";
import { forbidden, getAuthUser, requireRoleForRequest, unauthorized } from "@/lib/session";
import { getOrchestrationRunSnapshot } from "@/lib/orchestrator";
import { subscribeOrcEvents } from "@/lib/orchestrator-events";

/**
 * Server-Sent Events stream for a single orchestration run.
 *
 *   GET /api/companies/[id]/orchestrate/stream?runId=...
 *
 * Emits:
 *   event: snapshot     (current run state on connect)
 *   event: <kind>       (one of orchestrator-events.OrcEventKind)
 *   data:  { ...event payload as JSON }
 *
 * Sends a `: heartbeat\n\n` comment every 25s to keep proxies awake.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getAuthUser();
  if (!user) return unauthorized();
  const { id: companyId } = await params;
  const check = await requireRoleForRequest(user.id, "viewer", { companyId });
  if (!check.ok) return forbidden();

  const runId = request.nextUrl.searchParams.get("runId");
  if (!runId) {
    return new Response(JSON.stringify({ error: "runId required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const initial = await getOrchestrationRunSnapshot(runId);
  if (!initial || initial.companyId !== companyId) {
    return new Response(JSON.stringify({ error: "run not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      const safeEnqueue = (chunk: string) => {
        if (closed) return;
        try { controller.enqueue(encoder.encode(chunk)); }
        catch { closed = true; }
      };

      const send = (event: string, data: unknown) => {
        safeEnqueue(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };

      // Initial snapshot
      send("snapshot", initial);

      const unsub = subscribeOrcEvents(runId, (e) => {
        send(e.kind, e);
        if (e.kind === "run_done" || e.kind === "run_failed" || e.kind === "run_cancelled") {
          // Give one tick for last message to flush, then close.
          setTimeout(() => { if (!closed) { try { controller.close(); } catch {} ; closed = true; } }, 200);
        }
      });

      const heartbeat = setInterval(() => safeEnqueue(`: hb\n\n`), 25_000);

      const cleanup = () => {
        clearInterval(heartbeat);
        unsub();
        if (!closed) { try { controller.close(); } catch {} ; closed = true; }
      };

      request.signal.addEventListener("abort", cleanup);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
