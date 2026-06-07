import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const {
  mockGetAuthUser,
  mockRequireRoleForRequest,
  mockGetOrchestrationRun,
  mockGetOrchestrationRunSnapshot,
  mockApproveStep,
  mockRejectStep,
} = vi.hoisted(() => ({
  mockGetAuthUser: vi.fn(),
  mockRequireRoleForRequest: vi.fn(),
  mockGetOrchestrationRun: vi.fn(),
  mockGetOrchestrationRunSnapshot: vi.fn(),
  mockApproveStep: vi.fn(),
  mockRejectStep: vi.fn(),
}));

vi.mock("@/lib/session", () => ({
  getAuthUser: mockGetAuthUser,
  requireRoleForRequest: mockRequireRoleForRequest,
  unauthorized: () => new Response("unauthorized", { status: 401 }),
  forbidden: () => new Response("forbidden", { status: 403 }),
}));

vi.mock("@/lib/orchestrator", () => ({
  getOrchestrationRun: mockGetOrchestrationRun,
  getOrchestrationRunSnapshot: mockGetOrchestrationRunSnapshot,
  approveStep: mockApproveStep,
  rejectStep: mockRejectStep,
}));

import { POST } from "./route";

const PARAMS = { params: Promise.resolve({ id: "co_1" }) };

describe("POST /api/companies/[id]/orchestrate/approve", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAuthUser.mockResolvedValue({ id: "user_1" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: true, role: "member" });
    mockGetOrchestrationRun.mockReturnValue(undefined);
    mockGetOrchestrationRunSnapshot.mockResolvedValue({
      id: "orc_1",
      companyId: "co_1",
      objective: "Deploy app",
      status: "running",
      trigger: "manual",
      steps: [],
      startedAt: "2026-06-04T00:00:00.000Z",
    });
    mockApproveStep.mockResolvedValue(true);
    mockRejectStep.mockResolvedValue(true);
  });

  it("approves a persisted run when the live process map has no run", async () => {
    const res = await POST(jsonRequest({ runId: "orc_1", stepId: "s1", decision: "approve" }), PARAMS);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true, decision: "approve" });
    expect(mockGetOrchestrationRunSnapshot).toHaveBeenCalledWith("orc_1");
    expect(mockApproveStep).toHaveBeenCalledWith("orc_1", "s1");
  });

  it("rejects persisted runs from another company", async () => {
    mockGetOrchestrationRunSnapshot.mockResolvedValueOnce({
      id: "orc_1",
      companyId: "co_other",
      objective: "Deploy app",
      status: "running",
      trigger: "manual",
      steps: [],
      startedAt: "2026-06-04T00:00:00.000Z",
    });

    const res = await POST(jsonRequest({ runId: "orc_1", stepId: "s1", decision: "approve" }), PARAMS);

    expect(res.status).toBe(404);
    expect(mockApproveStep).not.toHaveBeenCalled();
  });
});

function jsonRequest(body: Record<string, unknown>) {
  return new Request("http://x/api/companies/co_1/orchestrate/approve", {
    method: "POST",
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}
