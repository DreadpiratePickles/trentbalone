import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetAuthUser, mockRequireRoleForRequest, mockCreateOrUpdateWikiNote } = vi.hoisted(() => ({
  mockGetAuthUser: vi.fn(),
  mockRequireRoleForRequest: vi.fn(),
  mockCreateOrUpdateWikiNote: vi.fn(),
}));

vi.mock("@/lib/session", () => ({
  getAuthUser: mockGetAuthUser,
  requireRoleForRequest: mockRequireRoleForRequest,
  unauthorized: () => Response.json({ error: "Unauthorized" }, { status: 401 }),
  forbidden: () => Response.json({ error: "Forbidden" }, { status: 403 }),
}));

vi.mock("@/lib/wiki-notes", () => ({
  createOrUpdateWikiNote: mockCreateOrUpdateWikiNote,
  normalizePath: (path: string) => path.replace(/\/+/g, "/"),
  slugify: (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
}));

import { POST } from "./route";

describe("/api/companies/[id]/wiki-notes/upload", () => {
  beforeEach(() => {
    mockGetAuthUser.mockReset();
    mockRequireRoleForRequest.mockReset();
    mockCreateOrUpdateWikiNote.mockReset();
    mockGetAuthUser.mockResolvedValue({ id: "user_1", email: "u@example.com" });
    mockRequireRoleForRequest.mockResolvedValue({ ok: true, role: "member" });
  });

  it("rejects oversized files before writing a wiki note", async () => {
    const form = new FormData();
    form.set("file", new File([new Uint8Array(5 * 1024 * 1024 + 1)], "too-big.txt", { type: "text/plain" }));

    const res = await POST(
      new Request("http://x/api/companies/co_1/wiki-notes/upload", { method: "POST", body: form }) as never,
      { params: Promise.resolve({ id: "co_1" }) }
    );

    expect(res.status).toBe(413);
    await expect(res.json()).resolves.toEqual({ error: "File exceeds 5 MB upload limit" });
    expect(mockCreateOrUpdateWikiNote).not.toHaveBeenCalled();
  });
});
