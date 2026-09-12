import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockGetAuthUser, mockRequireRoleForRequest } = vi.hoisted(() => ({
  mockGetAuthUser: vi.fn(),
  mockRequireRoleForRequest: vi.fn(),
}));

vi.mock("@/lib/session", () => ({
  getAuthUser: mockGetAuthUser,
  requireRoleForRequest: mockRequireRoleForRequest,
  unauthorized: () => new Response("u", { status: 401 }),
  forbidden: () => new Response("f", { status: 403 }),
}));

vi.mock("@/lib/store", () => ({
  store: {
    listWorkbenchSessions: vi.fn().mockResolvedValue([]),
    getCompany: vi.fn().mockResolvedValue({ id: "c1" }),
    listWorkbenchEvents: vi.fn().mockResolvedValue([]),
  }
}));

vi.mock("@/lib/workbench", () => ({
  createWorkbenchSession: vi.fn().mockResolvedValue({ id: "ws1", companyId: "c1" }),
}));

import { GET, POST } from "./route";
import { createWorkbenchSession } from "@/lib/workbench";

describe("/api/workbench RBAC", () => {
  beforeEach(() => {
    mockGetAuthUser.mockReset();
    mockRequireRoleForRequest.mockReset();
    vi.mocked(createWorkbenchSession).mockClear();
  });

  it("GET: returns 400 when companyId is missing", async () => {
    mockGetAuthUser.mockResolvedValue({ id: "u1" });
    const res = await GET(new Request("http://x/api/workbench"));
    expect(res.status).toBe(400);
  });

  it("GET: returns 403 when user lacks viewer role", async () => {
    mockGetAuthUser.mockResolvedValue({ id: "u1" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: false });
    const res = await GET(new Request("http://x/api/workbench?companyId=c1"));
    expect(res.status).toBe(403);
    expect(mockRequireRoleForRequest).toHaveBeenCalledWith("u1", "viewer", { companyId: "c1" });
  });

  it("GET: returns 200 with list of sessions on success", async () => {
    mockGetAuthUser.mockResolvedValue({ id: "u1" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: true, role: "viewer" });
    const res = await GET(new Request("http://x/api/workbench?companyId=c1"));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.sessions).toBeDefined();
  });

  it("POST: returns 403 when user lacks member role", async () => {
    mockGetAuthUser.mockResolvedValue({ id: "u1" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: false });
    const res = await POST(new Request("http://x/api/workbench", {
      method: "POST",
      body: JSON.stringify({ companyId: "c1", objective: "Fix it" }),
    }));
    expect(res.status).toBe(403);
    expect(mockRequireRoleForRequest).toHaveBeenCalledWith("u1", "member", { companyId: "c1" });
  });

  it("POST: accepts daytona now that a real provider adapter exists", async () => {
    mockGetAuthUser.mockResolvedValue({ id: "u1" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: true, role: "member" });

    const res = await POST(new Request("http://x/api/workbench", {
      method: "POST",
      body: JSON.stringify({ companyId: "c1", objective: "Fix it", provider: "daytona" }),
    }));

    expect(res.status).toBe(201);
    expect(mockRequireRoleForRequest).toHaveBeenCalledWith("u1", "member", { companyId: "c1" });
  });

  it("POST: returns 201 on success", async () => {
    mockGetAuthUser.mockResolvedValue({ id: "u1" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: true, role: "member" });
    const res = await POST(new Request("http://x/api/workbench", {
      method: "POST",
      body: JSON.stringify({ companyId: "c1", objective: "Fix it" }),
    }));
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.session).toBeDefined();
  });

  it("POST: can create a session without enqueueing so imports happen first", async () => {
    mockGetAuthUser.mockResolvedValue({ id: "u1" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: true, role: "member" });

    const res = await POST(new Request("http://x/api/workbench", {
      method: "POST",
      body: JSON.stringify({ companyId: "c1", objective: "Import then build", enqueue: false }),
    }));

    expect(res.status).toBe(201);
    expect(createWorkbenchSession).toHaveBeenCalledWith(expect.objectContaining({
      enqueue: false,
    }));
  });

  it("POST: forwards sanitized app-solo attribution metadata", async () => {
    mockGetAuthUser.mockResolvedValue({ id: "u1" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: true, role: "member" });

    const res = await POST(new Request("http://x/api/workbench", {
      method: "POST",
      body: JSON.stringify({
        companyId: "c1",
        objective: "[app-solo] Growth / HyperFrames",
        metadata: {
          appSolo: {
            agentRole: "growth",
            agentLabel: "Growth / Marketing",
            appId: "hyperframes",
            appName: "HyperFrames",
            appScopes: ["hyperframes:render"],
            deliverables: ["video brief"],
            approvalGates: ["external_publish"],
            mode: "design",
          },
          ignored: "nope",
        },
      }),
    }));

    expect(res.status).toBe(201);
    expect(createWorkbenchSession).toHaveBeenCalledWith(expect.objectContaining({
      metadata: {
        appSolo: {
          agentRole: "growth",
          agentLabel: "Growth / Marketing",
          appId: "hyperframes",
          appName: "HyperFrames",
          appScopes: ["hyperframes:render"],
          deliverables: ["video brief"],
          approvalGates: ["external_publish"],
          mode: "design",
        },
      },
    }));
  });

  it("POST: forwards sanitized Workbench agent contract metadata", async () => {
    mockGetAuthUser.mockResolvedValue({ id: "u1" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: true, role: "member" });

    const res = await POST(new Request("http://x/api/workbench", {
      method: "POST",
      body: JSON.stringify({
        companyId: "c1",
        objective: "[workbench-agent] Engineer",
        metadata: {
          agentRun: {
            agentRole: "engineer",
            agentLabel: "Engineer",
            tools: ["github:read [real]", "steel:scrape [unavailable]"],
            deliverables: ["implementation plan"],
            approvalGates: ["github.pr"],
            evidenceRequired: ["tests", "screenshots"],
            mode: "build",
            ignored: "nope",
          },
        },
      }),
    }));

    expect(res.status).toBe(201);
    expect(createWorkbenchSession).toHaveBeenCalledWith(expect.objectContaining({
      metadata: {
        agentRun: {
          agentRole: "engineer",
          agentLabel: "Engineer",
          tools: ["github:read [real]", "steel:scrape [unavailable]"],
          deliverables: ["implementation plan"],
          approvalGates: ["github.pr"],
          evidenceRequired: ["tests", "screenshots"],
          mode: "build",
        },
      },
    }));
  });

  it("POST: drops invalid app-solo attribution metadata", async () => {
    mockGetAuthUser.mockResolvedValue({ id: "u1" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: true, role: "member" });

    const res = await POST(new Request("http://x/api/workbench", {
      method: "POST",
      body: JSON.stringify({
        companyId: "c1",
        objective: "[app-solo] Bad role",
        metadata: {
          appSolo: {
            agentRole: "intruder",
            agentLabel: "Growth / Marketing",
            appId: "hyperframes",
            appName: "HyperFrames",
          },
        },
      }),
    }));

    expect(res.status).toBe(201);
    expect(createWorkbenchSession).toHaveBeenCalledWith(expect.objectContaining({
      metadata: undefined,
    }));
  });
});
