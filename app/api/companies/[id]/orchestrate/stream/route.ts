import { NextRequest } from "next/server";
import { forbidden, getAuthUser, requireRoleForRequest, unauthorized } from "@/lib/session";
import { getOrchestrationRunSnapshot } from "@/lib/orchestrator";
import { subscribeOrcEvents } from "@/lib/orchestrator-events";
import { store } from "@/lib/store";

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

      const TERMINAL_BY_STATUS: Record<string, "run_done" | "run_failed" | "run_cancelled" | "run_awaiting_approval"> = {
        awaiting_approval: "run_awaiting_approval",
        completed: "run_done",
        failed: "run_failed",
        cancelled: "run_cancelled",
      };
      const sendTerminal = (kind: "run_done" | "run_failed" | "run_cancelled" | "run_awaiting_approval", run: unknown) => {
        send(kind, { kind, runId, at: new Date().toISOString(), run });
        setTimeout(() => { if (!closed) { try { controller.close(); } catch {} ; closed = true; } }, 200);
      };

      // RC2 fix (Fix Plan Slice 1): a client (re)connecting to a run that is
      // already terminal gets the terminal event immediately — refresh and
      // reconnect-after-completion must never hang on a silent stream.
      const initialTerminal = TERMINAL_BY_STATUS[initial.status];
      if (initialTerminal) {
        sendTerminal(initialTerminal, initial);
        return;
      }

      let inProcessCount = 0;
      const unsub = subscribeOrcEvents(runId, (e) => {
        inProcessCount += 1;
        send(e.kind, e);
        if (e.kind === "run_done" || e.kind === "run_failed" || e.kind === "run_cancelled" || e.kind === "run_awaiting_approval") {
          // Give one tick for last message to flush, then close.
          setTimeout(() => { if (!closed) { try { controller.close(); } catch {} ; closed = true; } }, 200);
        }
      });

      const heartbeat = setInterval(() => safeEnqueue(`: hb\n\n`), 25_000);

      // RC2 fix (Fix Plan Slice 1): the in-process event bus never fires when
      // the run executes on a worker or another instance. Every 5s:
      //   1. If the bus has been silent for this run, replay newly persisted
      //      OrchestratorEvent rows (DB is the durable source of truth) so the
      //      client gets live progress, not just the final state.
      //   2. If the persisted run reached a terminal status without a terminal
      //      event, synthesize one — the web UI must converge regardless of
      //      which process completed the run.
      let lastReplayedSeq = 0;
      const reconcile = setInterval(async () => {
        if (closed) return;
        try {
          if (inProcessCount === 0) {
            const persisted = await store.listOrchestratorEvents(runId).catch(() => []);
            for (const event of persisted) {
              if (event.seq <= lastReplayedSeq) continue;
              lastReplayedSeq = event.seq;
              send(event.kind, {
                kind: event.kind,
                runId,
                at: (event.payload?.at as string | undefined) ?? event.createdAt,
                detail: event.payload?.detail,
                run: event.payload?.run,
                step: event.payload?.step,
              });
            }
          }
          const fresh = await getOrchestrationRunSnapshot(runId);
          const terminal = fresh && TERMINAL_BY_STATUS[fresh.status];
          if (fresh && terminal) {
            sendTerminal(terminal, fresh);
          }
        } catch {
          // best-effort — the in-process path and client polling still apply
        }
      }, 5_000);

      const cleanup = () => {
        clearInterval(heartbeat);
        clearInterval(reconcile);
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
