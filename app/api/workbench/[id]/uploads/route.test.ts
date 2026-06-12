import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetAuthUser, mockRequireRoleForRequest } = vi.hoisted(() => ({
  mockGetAuthUser: vi.fn(),
  mockRequireRoleForRequest: vi.fn(),
}));

const {
  mockGetWorkbenchSession,
  mockCreateDocument,
  mockListWorkbenchEvents,
  mockEnsureWorkbenchSandboxReady,
  mockWriteFile,
  mockCaptureArtifact,
  mockRecordEvent,
} = vi.hoisted(() => ({
  mockGetWorkbenchSession: vi.fn(),
  mockCreateDocument: vi.fn(),
  mockListWorkbenchEvents: vi.fn(),
  mockEnsureWorkbenchSandboxReady: vi.fn(),
  mockWriteFile: vi.fn(),
  mockCaptureArtifact: vi.fn(),
  mockRecordEvent: vi.fn(),
}));

vi.mock("@/lib/session", () => ({
  getAuthUser: mockGetAuthUser,
  requireRoleForRequest: mockRequireRoleForRequest,
  unauthorized: () => new Response("u", { status: 401 }),
  forbidden: () => new Response("f", { status: 403 }),
}));

vi.mock("@/lib/store", () => ({
  store: {
    getWorkbenchSession: mockGetWorkbenchSession,
    createDocument: mockCreateDocument,
    listWorkbenchEvents: mockListWorkbenchEvents,
  },
}));

vi.mock("@/lib/with-rls", () => ({
  withRlsContext: (_companyId: string, fn: () => unknown) => fn(),
}));

vi.mock("@/lib/workbench-provider", () => ({
  getWorkbenchProvider: () => ({
    name: "mock_local",
    writeFile: mockWriteFile,
    captureArtifact: mockCaptureArtifact,
  }),
}));

vi.mock("@/lib/workbench-providers", () => ({}));

vi.mock("@/lib/workbench-orchestrator", () => ({
  ensureWorkbenchSandboxReady: mockEnsureWorkbenchSandboxReady,
}));

vi.mock("@/lib/workbench-build-helpers", () => ({
  recordEvent: mockRecordEvent,
}));

import { POST } from "./route";

describe("POST /api/workbench/[id]/uploads", () => {
  beforeEach(() => {
    mockGetAuthUser.mockReset().mockResolvedValue({ id: "u1" });
    mockRequireRoleForRequest.mockReset().mockResolvedValue({ ok: true });
    mockGetWorkbenchSession.mockReset().mockResolvedValue({
      id: "ws_1",
      companyId: "co_1",
      provider: "mock_local",
      agentRole: "engineer",
    });
    mockCreateDocument.mockReset().mockResolvedValue({ id: "doc_upload" });
    mockListWorkbenchEvents.mockReset().mockResolvedValue([]);
    mockEnsureWorkbenchSandboxReady.mockReset().mockResolvedValue(undefined);
    mockWriteFile.mockReset().mockResolvedValue(undefined);
    mockCaptureArtifact.mockReset().mockResolvedValue({});
    mockRecordEvent.mockReset().mockResolvedValue(undefined);
  });

  it("writes uploaded text files into the workspace and creates bounded retrieval documents", async () => {
    const form = new FormData();
    form.append("files", new File(["# Roadmap\nBuild import first"], "roadmap.md", { type: "text/markdown" }));
    form.append("paths", JSON.stringify(["docs/roadmap.md"]));

    const res = await POST(new Request("http://x/api/workbench/ws_1/uploads", { method: "POST", body: form }), {
      params: Promise.resolve({ id: "ws_1" }),
    });

    expect(res.status).toBe(201);
    expect(mockWriteFile).toHaveBeenCalledWith(expect.objectContaining({ id: "ws_1" }), "docs/roadmap.md", expect.stringContaining("Build import first"));
    expect(mockCreateDocument).toHaveBeenCalledWith(expect.objectContaining({
      companyId: "co_1",
      type: "agent_note",
      title: "Workbench upload: docs/roadmap.md",
      source: "workbench-upload:ws_1:docs/roadmap.md",
      memoryTier: "semantic",
      content: expect.stringContaining("Build import first"),
    }));
  });

  it("does not ingest obvious secret/config uploads into retrieval memory", async () => {
    const form = new FormData();
    form.append("files", new File(["OPENAI_API_KEY=sk-test"], ".env", { type: "text/plain" }));
    form.append("paths", JSON.stringify([".env"]));

    const res = await POST(new Request("http://x/api/workbench/ws_1/uploads", { method: "POST", body: form }), {
      params: Promise.resolve({ id: "ws_1" }),
    });

    expect(res.status).toBe(201);
    expect(mockWriteFile).toHaveBeenCalled();
    expect(mockCreateDocument).not.toHaveBeenCalled();
  });
});
