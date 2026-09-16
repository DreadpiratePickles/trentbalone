import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import { store } from "@/lib/store";

const { mockGetAuthUser, mockRequireRoleForRequest } = vi.hoisted(() => ({
  mockGetAuthUser: vi.fn(),
  mockRequireRoleForRequest: vi.fn(),
}));

vi.mock("@/lib/session", () => ({
  getAuthUser: mockGetAuthUser,
  requireRoleForRequest: mockRequireRoleForRequest,
  unauthorized: () => new Response("unauthorized", { status: 401 }),
  forbidden: () => new Response("forbidden", { status: 403 }),
}));

import { GET, POST } from "./route";
import { DELETE, PATCH } from "./[webhookId]/route";

const companyId = `co_wh_route_${Date.now()}`;
const params = { params: Promise.resolve({ id: companyId }) };

function jsonRequest(method: string, body?: Record<string, unknown>) {
  return new Request(`http://x/api/companies/${companyId}/webhooks`, {
    method,
    body: body ? JSON.stringify(body) : undefined,
  }) as unknown as NextRequest;
}

describe("/api/companies/[id]/webhooks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAuthUser.mockResolvedValue({ id: "user_1" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: true, role: "admin" });
  });

  it("requires an admin role to create", async () => {
    mockRequireRoleForRequest.mockResolvedValueOnce({ ok: false });
    const res = await POST(jsonRequest("POST", { url: "https://r.test/h", events: ["run.completed"] }), params);
    expect(res.status).toBe(403);
    expect(mockRequireRoleForRequest).toHaveBeenCalledWith("user_1", "admin", { companyId });
  });

  it("rejects an unknown event name and a non-https url", async () => {
    const bad = await POST(jsonRequest("POST", { url: "https://r.test/h", events: ["spend.paused"] }), params);
    expect(bad.status).toBe(400);
    const badUrl = await POST(jsonRequest("POST", { url: "http://r.test/h", events: ["run.completed"] }), params);
    expect(badUrl.status).toBe(400);
  });

  it("creates a webhook, returns the plaintext secret exactly once, and masks it afterwards", async () => {
    const res = await POST(jsonRequest("POST", { url: "https://r.test/h", events: ["run.completed"], action: "create_task" }), params);
    expect(res.status).toBe(201);
    const created = await res.json();
    expect(created.secret).toMatch(/^whsec_/);
    expect(created.webhook.secretRef).not.toContain(created.secret);
    expect(created.webhook.hasSecret).toBe(true);

    const list = await (await GET(jsonRequest("GET"), params)).json();
    const listed = list.webhooks.find((w: { id: string }) => w.id === created.webhook.id);
    expect(listed).toBeTruthy();
    expect(JSON.stringify(list)).not.toContain(created.secret);
    const stored = await store.getWebhook(companyId, created.webhook.id);
    expect(JSON.stringify(list)).not.toContain(stored?.secretRef);
  });

  it("updates and deletes through the item route with admin role", async () => {
    const created = await (await POST(jsonRequest("POST", { url: "https://r.test/h", events: ["run.completed"] }), params)).json();
    const itemParams = { params: Promise.resolve({ id: companyId, webhookId: created.webhook.id }) };

    const patched = await PATCH(jsonRequest("PATCH", { enabled: false, events: ["run.failed"] }), itemParams);
    expect(patched.status).toBe(200);
    const body = await patched.json();
    expect(body.webhook.enabled).toBe(false);
    expect(body.webhook.events).toEqual(["run.failed"]);

    mockRequireRoleForRequest.mockResolvedValueOnce({ ok: false });
    expect((await DELETE(jsonRequest("DELETE"), itemParams)).status).toBe(403);
    expect((await DELETE(jsonRequest("DELETE"), itemParams)).status).toBe(200);
    expect((await DELETE(jsonRequest("DELETE"), itemParams)).status).toBe(404);
  });
});
