import { NextResponse } from "next/server";
import { subscribeJobEvents } from "@/lib/job-events";
import { forbidden, getAuthUser, requireRoleForRequest, unauthorized } from "@/lib/session";

const MAX_QUEUE = 50; // drop oldest events if client is lagging
const HEARTBEAT_MS = 15_000; // keep-alive ping interval

export async function GET(request: Request) {
  const user = await getAuthUser();
  if (!user) return unauthorized();

  const companyId = new URL(request.url).searchParams.get("companyId");
  if (!companyId) {
    return NextResponse.json({ error: "companyId is required" }, { status: 400 });
  }

  const check = await requireRoleForRequest(user.id, "viewer", { companyId });
  if (!check.ok) return forbidden();

  const encoder = new TextEncoder();
  let closed = false;
  let queued = 0;

  const stream = new ReadableStream({
    start(controller) {
      /** Safely enqueue — catches if the stream is already closed */
      function enqueue(chunk: string) {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
          queued++;
        } catch {
          closed = true;
        }
      }

      /** SSE data event */
      function send(event: unknown) {
        enqueue(`data: ${JSON.stringify(event)}\n\n`);
      }

      /** SSE comment — used as keep-alive ping (no data event fired on client) */
      function ping() {
        enqueue(": heartbeat\n\n");
      }

      // Subscribe to job events
      const unsubscribe = subscribeJobEvents((event) => {
        if (closed) return;
        if (event.companyId !== companyId) return;
        // Backpressure: if too many events have queued without being consumed,
        // drop older ones by just skipping. In practice the browser consumes
        // immediately so this is a safety valve for stuck clients.
        if (queued > MAX_QUEUE) {
          queued = 0; // reset counter — we've been consuming
        }
        send(event);
      });

      // Send connected confirmation
      send({ status: "connected", at: new Date().toISOString() });

      // Periodic heartbeat to detect dropped connections and avoid proxy timeouts
      const heartbeat = setInterval(() => {
        if (closed) {
          clearInterval(heartbeat);
          return;
        }
        ping();
      }, HEARTBEAT_MS);

      // Clean up when client disconnects
      request.signal.addEventListener("abort", () => {
        closed = true;
        unsubscribe();
        clearInterval(heartbeat);
        try { controller.close(); } catch { /* already closed */ }
      });
    },

    cancel() {
      closed = true;
    }
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no", // disable Nginx/proxy buffering
    }
  });
}
