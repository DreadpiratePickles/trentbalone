import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetAuthUser, mockRequireRoleForRequest, mockStore } = vi.hoisted(() => ({
  mockGetAuthUser: vi.fn(),
  mockRequireRoleForRequest: vi.fn(),
  mockStore: {
    getWorkbenchSession: vi.fn(),
  },
}));

vi.mock("@/lib/session", () => ({
  getAuthUser: mockGetAuthUser,
  requireRoleForRequest: mockRequireRoleForRequest,
  unauthorized: () => new Response("u", { status: 401 }),
  forbidden: () => new Response("f", { status: 403 }),
}));

vi.mock("@/lib/store", () => ({
  store: mockStore,
}));

import { GET } from "./route";

describe("/api/workbench/[id]/preview", () => {
  beforeEach(() => {
    vi.stubEnv("PORT", "8080");
    mockGetAuthUser.mockReset();
    mockRequireRoleForRequest.mockReset();
    mockStore.getWorkbenchSession.mockReset();
    mockGetAuthUser.mockResolvedValue({ id: "u1" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: true, role: "viewer" });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("rejects stale previews that point at Trent's own host app port", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    mockStore.getWorkbenchSession.mockResolvedValue({
      id: "ws1",
      companyId: "c1",
      previewUrl: "http://localhost:8080",
    });

    const res = await GET(new Request("http://trent.test/api/workbench/ws1/preview/"), {
      params: Promise.resolve({ id: "ws1", path: [] }),
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "preview points at the Trent app port, not a sandbox server",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("proxies sandbox HTML and rewrites absolute asset paths", async () => {
    mockStore.getWorkbenchSession.mockResolvedValue({
      id: "ws1",
      companyId: "c1",
      previewUrl: "http://localhost:4100",
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      '<html><head></head><body><script type="module" src="/src/main.tsx"></script></body></html>',
      { headers: { "content-type": "text/html" } },
    )));

    const res = await GET(new Request("http://trent.test/api/workbench/ws1/preview/"), {
      params: Promise.resolve({ id: "ws1", path: [] }),
    });
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain('<base href="/api/workbench/ws1/preview/">');
    expect(html).toContain('src="/api/workbench/ws1/preview/src/main.tsx"');
  });
});

