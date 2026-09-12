import { describe, it, expect, vi, beforeEach } from "vitest";
import type { WorkbenchArtifact } from "@/lib/types";
import type { WorkbenchFileEntry } from "@/lib/workbench-provider";

const {
  mockGetAuthUser,
  mockListWorkbenchArtifacts,
  mockListFiles,
  mockReadFile,
  mockRequireRoleForRequest,
  mockWriteFile,
} = vi.hoisted(() => ({
  mockGetAuthUser: vi.fn(),
  mockListWorkbenchArtifacts: vi.fn(),
  mockListFiles: vi.fn(),
  mockReadFile: vi.fn(),
  mockRequireRoleForRequest: vi.fn(),
  mockWriteFile: vi.fn(),
}));

vi.mock("@/lib/session", () => ({
  getAuthUser: mockGetAuthUser,
  requireRoleForRequest: mockRequireRoleForRequest,
  unauthorized: () => new Response("u", { status: 401 }),
  forbidden: () => new Response("f", { status: 403 }),
}));

vi.mock("@/lib/store", () => ({
  store: {
    getWorkbenchSession: vi.fn().mockResolvedValue({ id: "ws1", companyId: "c1", provider: "mock_local" }),
    listWorkbenchArtifacts: mockListWorkbenchArtifacts,
  }
}));

vi.mock("@/lib/workbench-provider", () => ({
  registerWorkbenchProvider: vi.fn(),
  getWorkbenchProvider: () => ({
    listFiles: mockListFiles,
    readFile: mockReadFile,
    writeFile: mockWriteFile,
  }),
}));

import { GET, POST } from "./route";

describe("/api/workbench/[id]/files RBAC", () => {
  beforeEach(() => {
    mockGetAuthUser.mockReset();
    mockRequireRoleForRequest.mockReset();
    mockListWorkbenchArtifacts.mockReset();
    mockListFiles.mockReset();
    mockReadFile.mockReset();
    mockWriteFile.mockReset();
    mockListWorkbenchArtifacts.mockResolvedValue([]);
    mockListFiles.mockResolvedValue([]);
    mockReadFile.mockResolvedValue("content");
    mockWriteFile.mockResolvedValue(undefined);
  });

  it("GET: returns 403 when user lacks viewer role", async () => {
    mockGetAuthUser.mockResolvedValue({ id: "u1" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: false });
    const res = await GET(new Request("http://x/api/workbench/ws1/files"), { params: Promise.resolve({ id: "ws1" }) });
    expect(res.status).toBe(403);
    expect(mockRequireRoleForRequest).toHaveBeenCalledWith("u1", "viewer", { companyId: "c1" });
  });

  it("GET: returns 200 on success", async () => {
    mockGetAuthUser.mockResolvedValue({ id: "u1" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: true, role: "viewer" });
    const res = await GET(new Request("http://x/api/workbench/ws1/files"), { params: Promise.resolve({ id: "ws1" }) });
    expect(res.status).toBe(200);
  });

  it("GET: hides provider bootstrap README unless a file artifact owns it", async () => {
    mockGetAuthUser.mockResolvedValue({ id: "u1" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: true, role: "viewer" });
    mockListFiles.mockResolvedValue([
      fileEntry("README.md"),
      fileEntry("operator-report.md"),
    ]);
    mockListWorkbenchArtifacts.mockResolvedValue([
      artifact({ path: "operator-report.md" }),
    ]);

    const res = await GET(new Request("http://x/api/workbench/ws1/files"), { params: Promise.resolve({ id: "ws1" }) });
    const body = await res.json();

    expect(body.files.map((file: WorkbenchFileEntry) => file.path)).toEqual(["operator-report.md"]);
  });

  it("GET: keeps README when the agent captured it as a file artifact", async () => {
    mockGetAuthUser.mockResolvedValue({ id: "u1" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: true, role: "viewer" });
    mockListFiles.mockResolvedValue([
      fileEntry("README.md"),
    ]);
    mockListWorkbenchArtifacts.mockResolvedValue([
      artifact({ path: "README.md" }),
    ]);

    const res = await GET(new Request("http://x/api/workbench/ws1/files"), { params: Promise.resolve({ id: "ws1" }) });
    const body = await res.json();

    expect(body.files.map((file: WorkbenchFileEntry) => file.path)).toEqual(["README.md"]);
  });

  it("POST (read): returns 403 when user lacks viewer role", async () => {
    mockGetAuthUser.mockResolvedValue({ id: "u1" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: false });
    const res = await POST(new Request("http://x/api/workbench/ws1/files", {
      method: "POST",
      body: JSON.stringify({ op: "read", path: "file.txt" }),
    }), { params: Promise.resolve({ id: "ws1" }) });
    expect(res.status).toBe(403);
    expect(mockRequireRoleForRequest).toHaveBeenCalledWith("u1", "viewer", { companyId: "c1" });
  });

  it("POST (read): returns 200 on success", async () => {
    mockGetAuthUser.mockResolvedValue({ id: "u1" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: true, role: "viewer" });
    const res = await POST(new Request("http://x/api/workbench/ws1/files", {
      method: "POST",
      body: JSON.stringify({ op: "read", path: "file.txt" }),
    }), { params: Promise.resolve({ id: "ws1" }) });
    expect(res.status).toBe(200);
  });

  it("POST (write): returns 403 when user lacks member role", async () => {
    mockGetAuthUser.mockResolvedValue({ id: "u1" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: false });
    const res = await POST(new Request("http://x/api/workbench/ws1/files", {
      method: "POST",
      body: JSON.stringify({ op: "write", path: "file.txt", content: "data" }),
    }), { params: Promise.resolve({ id: "ws1" }) });
    expect(res.status).toBe(403);
    expect(mockRequireRoleForRequest).toHaveBeenCalledWith("u1", "member", { companyId: "c1" });
  });

  it("POST (write): returns 200 on success", async () => {
    mockGetAuthUser.mockResolvedValue({ id: "u1" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: true, role: "member" });
    const res = await POST(new Request("http://x/api/workbench/ws1/files", {
      method: "POST",
      body: JSON.stringify({ op: "write", path: "file.txt", content: "data" }),
    }), { params: Promise.resolve({ id: "ws1" }) });
    expect(res.status).toBe(200);
  });
});

function fileEntry(path: string): WorkbenchFileEntry {
  return {
    name: path.split("/").pop() ?? path,
    path,
    isDir: false,
    sizeBytes: 32,
    modifiedAt: "2026-06-11T00:00:00.000Z",
  };
}

function artifact(overrides: Partial<WorkbenchArtifact>): WorkbenchArtifact {
  return {
    id: "artifact_1",
    companyId: "c1",
    sessionId: "ws1",
    kind: "file",
    title: overrides.path ?? "file",
    storageKey: `workbench/ws1/${overrides.path ?? "file"}`,
    mimeType: "text/markdown",
    sizeBytes: 32,
    path: overrides.path,
    createdAt: "2026-06-11T00:00:00.000Z",
    ...overrides,
  };
}
