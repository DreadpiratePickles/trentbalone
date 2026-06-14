import { beforeEach, describe, expect, it, vi } from "vitest";

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

import { GET, PATCH } from "./route";
import { store } from "@/lib/store";
import { makeId } from "@/lib/utils";

function req(companyId: string, body?: unknown) {
  return new Request(`http://x/api/companies/${companyId}/autonomy`, body ? { method: "PATCH", body: JSON.stringify(body) } : {});
}

describe("/api/companies/[id]/autonomy", () => {
  let companyId: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockGetAuthUser.mockResolvedValue({ id: "user_1" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: true, role: "member" });
    const company = await store.createCompany({ name: `Autonomy ${makeId("t")}`, brief: { vision: "x" } });
    companyId = company.id;
  });

  it("GET returns effective settings (defaults to supervised)", async () => {
    const res = await GET(req(companyId), { params: Promise.resolve({ id: companyId }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.autonomy.mode).toBe("supervised");
  });

  it("rejects an unauthenticated request", async () => {
    mockGetAuthUser.mockResolvedValueOnce(null);
    const res = await GET(req(companyId), { params: Promise.resolve({ id: companyId }) });
    expect(res.status).toBe(401);
  });

  it("rejects a caller without company access (cross-company)", async () => {
    mockRequireRoleForRequest.mockResolvedValueOnce({ ok: false });
    const res = await GET(req(companyId), { params: Promise.resolve({ id: companyId }) });
    expect(res.status).toBe(403);
  });

  it("rejects an invalid mode", async () => {
    const res = await PATCH(req(companyId, { mode: "godmode" }), { params: Promise.resolve({ id: companyId }) });
    expect(res.status).toBe(400);
  });

  it("rejects a negative numeric bound", async () => {
    const res = await PATCH(req(companyId, { dailySpendLimitCents: -10 }), { params: Promise.resolve({ id: companyId }) });
    expect(res.status).toBe(400);
  });

  it("PATCH persists settings and records the editor", async () => {
    const res = await PATCH(req(companyId, { mode: "autonomous", dailySpendLimitCents: 500, allowlistedToolScopes: ["growth:social:publish"] }), {
      params: Promise.resolve({ id: companyId }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.autonomy.mode).toBe("autonomous");
    expect(data.autonomy.dailySpendLimitCents).toBe(500);
    expect(data.autonomy.updatedByUserId).toBe("user_1");

    // Persisted: a fresh GET reflects the change.
    const after = await GET(req(companyId), { params: Promise.resolve({ id: companyId }) });
    expect((await after.json()).autonomy.mode).toBe("autonomous");
  });
});
