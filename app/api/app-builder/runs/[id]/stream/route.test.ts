import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockGetAuthUser,
  mockRequireRoleForRequest,
  mockCheckRateLimit,
  mockWithRlsContext,
  mockStore,
} = vi.hoisted(() => ({
  mockGetAuthUser: vi.fn(),
  mockRequireRoleForRequest: vi.fn(),
  mockCheckRateLimit: vi.fn(),
  mockWithRlsContext: vi.fn(async (_companyId: string, fn: () => Promise<Response>) => fn()),
  mockStore: {
    getWorkbenchSession: vi.fn(),
    listWorkbenchEvents: vi.fn(),
  },
}));

vi.mock("@/lib/session", () => ({
  getAuthUser: mockGetAuthUser,
  requireRoleForRequest: mockRequireRoleForRequest,
  unauthorized: () => new Response("unauthorized", { status: 401 }),
  forbidden: () => new Response("forbidden", { status: 403 }),
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: mockCheckRateLimit,
  rateLimitExceeded: (retryAfterSeconds: number) => Response.json({ error: "rate_limit_exceeded", retryAfterSeconds }, { status: 429 }),
}));
vi.mock("@/lib/with-rls", () => ({ withRlsContext: mockWithRlsContext }));
vi.mock("@/lib/store", () => ({ store: mockStore }));

import { publishWorkbenchStreamEvent } from "@/lib/workbench-event-stream";
import { GET } from "./route";

describe("/api/app-builder/runs/[id]/stream", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAuthUser.mockResolvedValue({ id: "user_1" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: true });
    mockCheckRateLimit.mockResolvedValue({ ok: true });
    mockStore.getWorkbenchSession.mockResolvedValue({
      id: "ws_1",
      companyId: "co_1",
      objective: "App Builder: ship",
      status: "running",
    });
    mockStore.listWorkbenchEvents.mockResolvedValue([
      event({ id: "evt_1", seq: 1, title: "older" }),
      event({ id: "evt_2", seq: 2, title: "newer" }),
    ]);
  });

  it("rejects a viewer without company access", async () => {
    mockRequireRoleForRequest.mockResolvedValue({ ok: false });

    const res = await GET(new Request("http://x/api/app-builder/runs/ws_1/stream?companyId=co_1"), {
      params: Promise.resolve({ id: "ws_1" }),
    });

    expect(res.status).toBe(403);
  });

  it("replays only events after Last-Event-ID and then streams live events", async () => {
    const controller = new AbortController();
    const res = await GET(new Request("http://x/api/app-builder/runs/ws_1/stream?companyId=co_1", {
      headers: { "Last-Event-ID": "1" },
      signal: controller.signal,
    }), { params: Promise.resolve({ id: "ws_1" }) });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    publishWorkbenchStreamEvent(event({ id: "evt_3", seq: 3, title: "live" }));
    const text = await readSseText(res, 2);
    controller.abort();

    expect(text).not.toContain("older");
    expect(text).toContain("id: 2");
    expect(text).toContain("event: command");
    expect(text).toContain("newer");
    expect(text).toContain("id: 3");
    expect(text).toContain("live");
  });
});

function event(patch: { id: string; seq: number; title: string }) {
  return {
    id: patch.id,
    seq: patch.seq,
    companyId: "co_1",
    sessionId: "ws_1",
    type: "shell" as const,
    status: "completed" as const,
    title: patch.title,
    content: patch.title,
    command: "npm test",
    createdAt: `2026-05-29T00:00:0${patch.seq}.000Z`,
  };
}

async function readSseText(res: Response, eventCount: number) {
  const reader = res.body?.getReader();
  if (!reader) throw new Error("missing response body");
  const decoder = new TextDecoder();
  let text = "";
  while ((text.match(/\n\n/g) ?? []).length < eventCount) {
    const next = await reader.read();
    if (next.done) break;
    text += decoder.decode(next.value, { stream: true });
  }
  await reader.cancel();
  return text;
}
