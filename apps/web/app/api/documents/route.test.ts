import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockGetAuthUser, mockRequireRoleForRequest, mockListDocuments, mockCreateDocument } = vi.hoisted(() => ({
  mockGetAuthUser: vi.fn(),
  mockRequireRoleForRequest: vi.fn(),
  mockListDocuments: vi.fn(),
  mockCreateDocument: vi.fn().mockResolvedValue({ id: "doc1" }),
}));

vi.mock("@/lib/session", () => ({
  getAuthUser: mockGetAuthUser,
  requireRoleForRequest: mockRequireRoleForRequest,
  unauthorized: () => new Response("u", { status: 401 }),
  forbidden: () => new Response("f", { status: 403 }),
}));

vi.mock("@/lib/store", () => ({
  store: {
    listDocuments: mockListDocuments,
    createDocument: mockCreateDocument,
  }
}));

import { GET, POST } from "./route";

describe("/api/documents RBAC", () => {
  beforeEach(() => {
    mockGetAuthUser.mockReset();
    mockRequireRoleForRequest.mockReset();
    mockListDocuments.mockReset();
    mockCreateDocument.mockReset();
    mockListDocuments.mockResolvedValue([]);
    mockCreateDocument.mockResolvedValue({ id: "doc1" });
  });

  it("GET: returns 400 when companyId is missing", async () => {
    mockGetAuthUser.mockResolvedValue({ id: "u1" });
    const res = await GET(new Request("http://x/api/documents"));
    expect(res.status).toBe(400);
  });

  it("GET: returns 403 when user lacks viewer role", async () => {
    mockGetAuthUser.mockResolvedValue({ id: "u1" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: false });
    const res = await GET(new Request("http://x/api/documents?companyId=c1"));
    expect(res.status).toBe(403);
    expect(mockRequireRoleForRequest).toHaveBeenCalledWith("u1", "viewer", { companyId: "c1" });
  });

  it("GET: returns 200 with documents on success", async () => {
    mockGetAuthUser.mockResolvedValue({ id: "u1" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: true, role: "viewer" });
    const res = await GET(new Request("http://x/api/documents?companyId=c1"));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.documents).toBeDefined();
  });

  it("GET: filters out expired and not-yet-valid documents", async () => {
    mockGetAuthUser.mockResolvedValue({ id: "u1" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: true, role: "viewer" });
    mockListDocuments.mockResolvedValue([
      { id: "current", validFrom: "2026-05-30T00:00:00.000Z" },
      { id: "expired", validTo: "2020-01-01T00:00:00.000Z" },
      { id: "future", validFrom: "2999-01-01T00:00:00.000Z" },
    ]);

    const res = await GET(new Request("http://x/api/documents?companyId=c1"));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.documents.map((doc: { id: string }) => doc.id)).toEqual(["current"]);
  });

  it("POST: returns 403 when user lacks member role", async () => {
    mockGetAuthUser.mockResolvedValue({ id: "u1" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: false });
    const res = await POST(new Request("http://x/api/documents", {
      method: "POST",
      body: JSON.stringify({ companyId: "c1", title: "Doc Title", content: "Doc Content" }),
    }));
    expect(res.status).toBe(403);
    expect(mockRequireRoleForRequest).toHaveBeenCalledWith("u1", "member", { companyId: "c1" });
  });

  it("POST: returns 201 with created document on success", async () => {
    mockGetAuthUser.mockResolvedValue({ id: "u1" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: true, role: "member" });
    const res = await POST(new Request("http://x/api/documents", {
      method: "POST",
      body: JSON.stringify({ companyId: "c1", title: "Doc Title", content: "Doc Content" }),
    }));
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.document).toBeDefined();
  });

  it("POST: stores uploaded company context as semantic memory when requested", async () => {
    mockGetAuthUser.mockResolvedValue({ id: "u1" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: true, role: "member" });

    const res = await POST(new Request("http://x/api/documents", {
      method: "POST",
      body: JSON.stringify({
        companyId: "c1",
        title: "Company packet",
        content: "ICP, offer, constraints",
        type: "brief",
        source: "user_upload",
        memoryTier: "semantic",
      }),
    }));

    expect(res.status).toBe(201);
    expect(mockCreateDocument).toHaveBeenCalledWith(expect.objectContaining({
      companyId: "c1",
      title: "Company packet",
      content: "ICP, offer, constraints",
      type: "brief",
      source: "user_upload",
      memoryTier: "semantic",
    }));
  });

  it("POST: rejects unsupported document types before hitting the store", async () => {
    mockGetAuthUser.mockResolvedValue({ id: "u1" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: true, role: "member" });

    const res = await POST(new Request("http://x/api/documents", {
      method: "POST",
      body: JSON.stringify({
        companyId: "c1",
        title: "Bad packet",
        content: "bad",
        type: "unknown",
      }),
    }));

    expect(res.status).toBe(400);
    expect(mockCreateDocument).not.toHaveBeenCalled();
  });
});
