import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockGetAuthUser, mockRequireRoleForRequest, mockResolveSupervisionApprovalExecution, mockWithRlsContext } = vi.hoisted(() => ({
  mockGetAuthUser: vi.fn(),
  mockRequireRoleForRequest: vi.fn(),
  mockResolveSupervisionApprovalExecution: vi.fn(),
  mockWithRlsContext: vi.fn(async (_companyId: string, fn: () => unknown) => fn()),
}));

vi.mock("@/lib/session", () => ({
  getAuthUser: mockGetAuthUser,
  requireRoleForRequest: mockRequireRoleForRequest,
  unauthorized: () => new Response("u", { status: 401 }),
  forbidden: () => new Response("f", { status: 403 }),
}));

const mockGetApproval = vi.fn();
const mockResolveApproval = vi.fn();
const mockUpdateTask = vi.fn();
const mockGetWorkbenchSession = vi.fn();
const mockUpdateWorkbenchSession = vi.fn();

vi.mock("@/lib/store", () => ({
  store: {
    getApproval: (...args: any[]) => mockGetApproval(...args),
    resolveApproval: (...args: any[]) => mockResolveApproval(...args),
    updateTask: (...args: any[]) => mockUpdateTask(...args),
    getWorkbenchSession: (...args: any[]) => mockGetWorkbenchSession(...args),
    updateWorkbenchSession: (...args: any[]) => mockUpdateWorkbenchSession(...args),
  }
}));

vi.mock("@/lib/supervision/approval-execution", () => ({
  resolveSupervisionApprovalExecution: mockResolveSupervisionApprovalExecution,
}));

vi.mock("@/lib/with-rls", () => ({ withRlsContext: mockWithRlsContext }));

import { POST } from "./route";

describe("/api/approvals/[id] RBAC", () => {
  beforeEach(() => {
    mockGetAuthUser.mockReset();
    mockRequireRoleForRequest.mockReset();
    mockGetApproval.mockReset();
    mockResolveApproval.mockReset();
    mockUpdateTask.mockReset();
    mockGetWorkbenchSession.mockReset();
    mockUpdateWorkbenchSession.mockReset();
    mockResolveSupervisionApprovalExecution.mockReset();
    mockWithRlsContext.mockClear();
  });

  it("POST: returns 404 when approval not found", async () => {
    mockGetAuthUser.mockResolvedValue({ id: "u1" });
    mockGetApproval.mockResolvedValue(null);
    const res = await POST(new Request("http://x/api/approvals/app1", {
      method: "POST",
      body: JSON.stringify({ status: "approved" })
    }), { params: Promise.resolve({ id: "app1" }) });
    expect(res.status).toBe(404);
  });

  it("POST: returns 403 when user lacks member role", async () => {
    mockGetAuthUser.mockResolvedValue({ id: "u1" });
    mockGetApproval.mockResolvedValue({ id: "app1", companyId: "c1" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: false });
    const res = await POST(new Request("http://x/api/approvals/app1", {
      method: "POST",
      body: JSON.stringify({ status: "approved" })
    }), { params: Promise.resolve({ id: "app1" }) });
    expect(res.status).toBe(403);
    expect(mockRequireRoleForRequest).toHaveBeenCalledWith("u1", "member", { companyId: "c1" });
  });

  it("POST: returns 200 with resolved approval on success", async () => {
    mockGetAuthUser.mockResolvedValue({ id: "u1" });
    mockGetApproval.mockResolvedValue({ id: "app1", companyId: "c1", taskId: "t1" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: true, role: "member" });
    mockResolveApproval.mockResolvedValue({ id: "app1", status: "approved", taskId: "t1" });
    mockUpdateTask.mockResolvedValue({ id: "t1" });

    const res = await POST(new Request("http://x/api/approvals/app1", {
      method: "POST",
      body: JSON.stringify({ status: "approved" })
    }), { params: Promise.resolve({ id: "app1" }) });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.approval).toBeDefined();
    expect(mockResolveApproval).toHaveBeenCalledWith("app1", "approved");
    expect(mockUpdateTask).toHaveBeenCalledWith("t1", { status: "queued" });
    expect(mockResolveSupervisionApprovalExecution).toHaveBeenCalledWith({
      approval: expect.objectContaining({ id: "app1", status: "approved" }),
      status: "approved",
    });
  });

  it("POST: resolves approvals inside the approval company's RLS context", async () => {
    const calls: string[] = [];
    mockWithRlsContext.mockImplementationOnce(async (_companyId: string, fn: () => unknown) => {
      calls.push("rls:start");
      try {
        return await fn();
      } finally {
        calls.push("rls:end");
      }
    });
    mockGetAuthUser.mockResolvedValue({ id: "u1" });
    mockGetApproval.mockResolvedValue({ id: "app1", companyId: "c1", taskId: "t1" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: true, role: "member" });
    mockResolveApproval.mockImplementation(async () => {
      calls.push("resolve");
      return { id: "app1", companyId: "c1", status: "approved", taskId: "t1" };
    });
    mockUpdateTask.mockImplementation(async () => {
      calls.push("task");
      return { id: "t1" };
    });
    mockResolveSupervisionApprovalExecution.mockImplementation(async () => {
      calls.push("supervision");
    });

    const res = await POST(new Request("http://x/api/approvals/app1", {
      method: "POST",
      body: JSON.stringify({ status: "approved" })
    }), { params: Promise.resolve({ id: "app1" }) });

    expect(res.status).toBe(200);
    expect(mockWithRlsContext).toHaveBeenCalledWith("c1", expect.any(Function));
    expect(calls).toEqual(["rls:start", "resolve", "task", "supervision", "rls:end"]);
  });

  it("POST: approving a Workbench plan clears only that session's plan gate so it can continue", async () => {
    mockGetAuthUser.mockResolvedValue({ id: "u1" });
    mockGetApproval.mockResolvedValue({
      id: "approval_plan",
      companyId: "c1",
      action: "workbench.plan",
      toolName: "workbench:workbench_1:plan",
    });
    mockRequireRoleForRequest.mockResolvedValue({ ok: true, role: "member" });
    mockResolveApproval.mockResolvedValue({
      id: "approval_plan",
      companyId: "c1",
      status: "approved",
      action: "workbench.plan",
      toolName: "workbench:workbench_1:plan",
    });
    mockGetWorkbenchSession.mockResolvedValue({
      id: "workbench_1",
      metadata: {
        approvalRequiredFor: ["workbench_plan", "deploy", "secret_access"],
      },
    });

    const res = await POST(new Request("http://x/api/approvals/approval_plan", {
      method: "POST",
      body: JSON.stringify({ status: "approved" }),
    }), { params: Promise.resolve({ id: "approval_plan" }) });

    expect(res.status).toBe(200);
    expect(mockGetWorkbenchSession).toHaveBeenCalledWith("workbench_1");
    expect(mockUpdateWorkbenchSession).toHaveBeenCalledWith("workbench_1", {
      metadata: {
        approvalRequiredFor: ["deploy", "secret_access"],
      },
    });
  });
});
