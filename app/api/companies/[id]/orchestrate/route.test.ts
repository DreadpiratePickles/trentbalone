import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

const {
  mockGetAuthUser,
  mockRequireRoleForRequest,
  mockLaunchOrchestration,
  mockListOrchestrationRunSnapshots,
  mockGetOrchestrationRunSnapshot,
  mockCancelOrchestration,
  mockAddCeoMessage,
} = vi.hoisted(() => ({
  mockGetAuthUser: vi.fn(),
  mockRequireRoleForRequest: vi.fn(),
  mockLaunchOrchestration: vi.fn(),
  mockListOrchestrationRunSnapshots: vi.fn(),
  mockGetOrchestrationRunSnapshot: vi.fn(),
  mockCancelOrchestration: vi.fn(),
  mockAddCeoMessage: vi.fn(),
}));

vi.mock("@/lib/session", () => ({
  getAuthUser: mockGetAuthUser,
  requireRoleForRequest: mockRequireRoleForRequest,
  unauthorized: () => new Response("unauthorized", { status: 401 }),
  forbidden: () => new Response("forbidden", { status: 403 }),
}));

vi.mock("@/lib/orchestrator", () => ({
  launchOrchestration: mockLaunchOrchestration,
  listOrchestrationRunSnapshots: mockListOrchestrationRunSnapshots,
  getOrchestrationRunSnapshot: mockGetOrchestrationRunSnapshot,
  cancelOrchestration: mockCancelOrchestration,
}));

vi.mock("@/lib/store", () => ({
  store: { addCeoMessage: mockAddCeoMessage },
}));

import { DELETE } from "./route";

const PARAMS = { params: Promise.resolve({ id: "co_1" }) };

describe("/api/companies/[id]/orchestrate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAuthUser.mockResolvedValue({ id: "user_1" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: true, role: "member" });
    mockGetOrchestrationRunSnapshot.mockResolvedValue(run({ companyId: "co_1" }));
    mockCancelOrchestration.mockResolvedValue(true);
  });

  it("DELETE cancels a persisted run after verifying company ownership", async () => {
    const res = await DELETE(nextRequest("http://x/api/companies/co_1/orchestrate?runId=orc_1"), PARAMS);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ cancelled: true });
    expect(mockGetOrchestrationRunSnapshot).toHaveBeenCalledWith("orc_1");
    expect(mockCancelOrchestration).toHaveBeenCalledWith("orc_1");
  });

  it("DELETE refuses to cancel a persisted run from another company", async () => {
    mockGetOrchestrationRunSnapshot.mockResolvedValueOnce(run({ companyId: "co_other" }));

    const res = await DELETE(nextRequest("http://x/api/companies/co_1/orchestrate?runId=orc_1"), PARAMS);

    expect(res.status).toBe(404);
    expect(mockCancelOrchestration).not.toHaveBeenCalled();
  });
});

function run(overrides: Partial<{ companyId: string }> = {}) {
  return {
    id: "orc_1",
    companyId: overrides.companyId ?? "co_1",
    objective: "Deploy app",
    status: "running",
    trigger: "manual",
    steps: [],
    startedAt: "2026-06-04T00:00:00.000Z",
  };
}

function nextRequest(url: string) {
  return Object.assign(new Request(url), { nextUrl: new URL(url) }) as unknown as NextRequest;
}
