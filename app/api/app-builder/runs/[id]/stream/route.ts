import { NextResponse } from "next/server";
import { checkRateLimit, rateLimitExceeded } from "@/lib/rate-limit";
import { forbidden, getAuthUser, requireRoleForRequest, unauthorized } from "@/lib/session";
import { store } from "@/lib/store";
import { encodeSse, subscribeWorkbenchStream, toTrenchpadStreamEvent } from "@/lib/workbench-event-stream";
import { withRlsContext } from "@/lib/with-rls";

type Params = { params: Promise<{ id: string }> | { id: string } };

const KEEP_ALIVE_MS = 15_000;

export async function GET(request: Request, context: Params) {
  const user = await getAuthUser();
  if (!user) return unauthorized();

  const { id } = await context.params;
  const companyId = new URL(request.url).searchParams.get("companyId");
  if (!companyId) return NextResponse.json({ error: "companyId is required" }, { status: 400 });

  const role = await requireRoleForRequest(user.id, "viewer", { companyId });
  if (!role.ok) return forbidden();

  const limit = await checkRateLimit(user.id, companyId);
  if (!limit.ok) return rateLimitExceeded(limit.retryAfterSeconds);

  return withRlsContext(companyId, async () => {
    const session = await store.getWorkbenchSession(id);
    if (!session || session.companyId !== companyId || !session.objective.startsWith("App Builder:")) {
      return NextResponse.json({ error: "App builder run not found" }, { status: 404 });
    }

    const lastSeq = lastEventSeq(request);
    const events = (await store.listWorkbenchEvents(session.id))
      .filter((event) => (event.seq ?? 0) > lastSeq)
      .map(toTrenchpadStreamEvent);

    const encoder = new TextEncoder();
    let unsubscribe: (() => void) | undefined;
    let keepAlive: ReturnType<typeof setInterval> | undefined;

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const event of events) controller.enqueue(encoder.encode(encodeSse(event)));

        unsubscribe = subscribeWorkbenchStream(session.id, (event) => {
          if (event.seq > lastSeq) controller.enqueue(encoder.encode(encodeSse(event)));
        });

        keepAlive = setInterval(() => {
          controller.enqueue(encoder.encode(":keep-alive\n\n"));
        }, KEEP_ALIVE_MS);

        request.signal.addEventListener("abort", () => {
          unsubscribe?.();
          if (keepAlive) clearInterval(keepAlive);
          try {
            controller.close();
          } catch {
            // Connection can already be closed by the client.
          }
        }, { once: true });
      },
      cancel() {
        unsubscribe?.();
        if (keepAlive) clearInterval(keepAlive);
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store, no-transform",
        Connection: "keep-alive",
      },
    });
  });
}

function lastEventSeq(request: Request): number {
  const fromHeader = Number.parseInt(request.headers.get("Last-Event-ID") ?? "", 10);
  if (Number.isFinite(fromHeader)) return fromHeader;
  const fromQuery = Number.parseInt(new URL(request.url).searchParams.get("seq") ?? "", 10);
  return Number.isFinite(fromQuery) ? fromQuery : 0;
}
