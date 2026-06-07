import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockGetAuthUser, mockRequireRoleForRequest, mockStore, mockCeoChatResponse, mockGeneralChatResponse } = vi.hoisted(() => ({
  mockGetAuthUser: vi.fn(),
  mockRequireRoleForRequest: vi.fn(),
  mockStore: {
    listCeoMessages: vi.fn(),
    listCeoSuggestions: vi.fn(),
    listArtifacts: vi.fn(),
    getCompany: vi.fn(),
    addCeoMessage: vi.fn(),
    addCeoSuggestion: vi.fn(),
    createTask: vi.fn(),
    createArtifact: vi.fn(),
    getCeoSuggestion: vi.fn(),
    updateCeoSuggestion: vi.fn(),
    listTasks: vi.fn(),
    listCycles: vi.fn(),
    listDocuments: vi.fn(),
    listReports: vi.fn(),
  },
  mockCeoChatResponse: vi.fn(),
  mockGeneralChatResponse: vi.fn(),
}));

vi.mock("@/lib/session", () => ({
  getAuthUser: mockGetAuthUser,
  requireRoleForRequest: mockRequireRoleForRequest,
  unauthorized: () => new Response("u", { status: 401 }),
  forbidden: () => new Response("f", { status: 403 }),
}));

vi.mock("@/lib/store", () => ({
  store: mockStore
}));

vi.mock("@/lib/ai", () => ({
  ceoChatResponse: mockCeoChatResponse,
  generalChatResponse: mockGeneralChatResponse,
}));

import { GET, POST, PATCH } from "./route";

describe("/api/ceo RBAC", () => {
  beforeEach(() => {
    mockGetAuthUser.mockReset();
    mockRequireRoleForRequest.mockReset();
    Object.values(mockStore).forEach((mock) => mock.mockReset());
    mockStore.listCeoMessages.mockResolvedValue([]);
    mockStore.listCeoSuggestions.mockResolvedValue([]);
    mockStore.listArtifacts.mockResolvedValue([]);
    mockStore.getCompany.mockResolvedValue({ id: "c1", name: "Acme", brief: {} });
    mockStore.addCeoMessage.mockImplementation(async (input) => ({ ...input, id: `msg_${input.direction}`, createdAt: "2026-06-01T00:00:00.000Z" }));
    mockStore.addCeoSuggestion.mockImplementation(async (input) => ({ ...input, id: "s_saved", status: "pending", createdAt: "2026-06-01T00:00:00.000Z" }));
    mockStore.createTask.mockImplementation(async (input) => ({ ...input, id: "task_1" }));
    mockStore.createArtifact.mockImplementation(async (input) => ({ ...input, id: "art_1" }));
    mockStore.getCeoSuggestion.mockResolvedValue({ id: "s1", companyId: "c1" });
    mockStore.updateCeoSuggestion.mockResolvedValue({ id: "s1" });
    mockStore.listTasks.mockResolvedValue([]);
    mockStore.listCycles.mockResolvedValue([]);
    mockStore.listDocuments.mockResolvedValue([]);
    mockStore.listReports.mockResolvedValue([]);
    mockCeoChatResponse.mockReset();
    mockGeneralChatResponse.mockReset();
    mockCeoChatResponse.mockResolvedValue({ message: "org reply", suggestions: [], createTasks: [], createArtifacts: [] });
    mockGeneralChatResponse.mockResolvedValue({ message: "gen reply", suggestions: [], createTasks: [], createArtifacts: [] });
  });

  it("GET: returns 403 when caller lacks viewer role", async () => {
    mockGetAuthUser.mockResolvedValue({ id: "u1" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: false, reason: "insufficient_role" });
    const req = { nextUrl: { searchParams: { get: () => "c1" } } } as any;
    const res = await GET(req);
    expect(res.status).toBe(403);
    expect(mockRequireRoleForRequest).toHaveBeenCalledWith("u1", "viewer", { companyId: "c1" });
  });

  it("POST: returns 403 when caller lacks member role", async () => {
    mockGetAuthUser.mockResolvedValue({ id: "u1" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: false, reason: "insufficient_role" });
    const req = {
      json: async () => ({ companyId: "c1", message: "hello" })
    } as any;
    const res = await POST(req);
    expect(res.status).toBe(403);
    expect(mockRequireRoleForRequest).toHaveBeenCalledWith("u1", "member", { companyId: "c1" });
  });

  it("PATCH: returns 403 when caller lacks member role", async () => {
    mockGetAuthUser.mockResolvedValue({ id: "u1" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: false, reason: "insufficient_role" });
    const req = {
      json: async () => ({ id: "s1", status: "done" })
    } as any;
    const res = await PATCH(req);
    expect(res.status).toBe(403);
    expect(mockRequireRoleForRequest).toHaveBeenCalledWith("u1", "member", { companyId: "c1" });
  });

  it("POST: gen mode uses the general LLM bridge without creating company work", async () => {
    mockGetAuthUser.mockResolvedValue({ id: "u1" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: true });
    const req = {
      json: async () => ({ companyId: "c1", message: "Explain quantum entanglement", mode: "gen" })
    } as any;

    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.mode).toBe("gen");
    expect(body.ceoMessage.content).toBe("gen reply");
    expect(mockGeneralChatResponse).toHaveBeenCalledWith(expect.any(Array), "Explain quantum entanglement");
    expect(mockCeoChatResponse).not.toHaveBeenCalled();
    expect(mockStore.createTask).not.toHaveBeenCalled();
    expect(mockStore.createArtifact).not.toHaveBeenCalled();
    expect(mockStore.addCeoSuggestion).not.toHaveBeenCalled();
  });

  it("POST: org mode sends documents and reports into company-aware chat context", async () => {
    mockGetAuthUser.mockResolvedValue({ id: "u1" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: true });
    const doc = { id: "doc_1", title: "Company brief", content: "We sell AI dispatch to HVAC shops.", type: "brief" };
    const report = { id: "rep_1", title: "Weekly report", summary: "Pipeline grew this week." };
    mockStore.listDocuments.mockResolvedValue([doc]);
    mockStore.listReports.mockResolvedValue([report]);
    const req = {
      json: async () => ({ companyId: "c1", message: "What do we sell?", mode: "org" })
    } as any;

    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.mode).toBe("org");
    expect(mockCeoChatResponse).toHaveBeenCalledWith(
      expect.objectContaining({ id: "c1" }),
      expect.any(Array),
      "What do we sell?",
      expect.objectContaining({ documents: [doc], reports: [report] })
    );
    expect(mockGeneralChatResponse).not.toHaveBeenCalled();
  });
});
