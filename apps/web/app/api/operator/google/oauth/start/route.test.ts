import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetAuthUser, mockIsOperator, mockBuildUrl } = vi.hoisted(() => ({
  mockGetAuthUser: vi.fn(),
  mockIsOperator: vi.fn(),
  mockBuildUrl: vi.fn(),
}));

vi.mock("@/lib/session", () => ({
  getAuthUser: mockGetAuthUser,
  unauthorized: () => new Response("unauthorized", { status: 401 }),
  forbidden: () => new Response("forbidden", { status: 403 }),
}));
vi.mock("@/lib/google/operator-auth", () => ({ isOperator: mockIsOperator }));
vi.mock("@/lib/google/google-oauth", () => ({ buildGoogleConsentUrl: mockBuildUrl }));

import { GET } from "./route";

describe("/api/operator/google/oauth/start", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAuthUser.mockResolvedValue({ id: "user_1", email: "boss@trent.app" });
    mockIsOperator.mockReturnValue(true);
    mockBuildUrl.mockReturnValue("https://accounts.google.com/o/oauth2/v2/auth?x=1");
  });

  it("returns 403 for non-operators", async () => {
    mockIsOperator.mockReturnValue(false);
    const res = await GET();
    expect(res.status).toBe(403);
  });

  it("returns the consent url for the operator", async () => {
    const res = await GET();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.authUrl).toContain("accounts.google.com");
    expect(body.state).toBeTruthy();
  });

  it("returns 503 when OAuth is not configured", async () => {
    mockBuildUrl.mockImplementation(() => { throw new Error("GOOGLE_CLIENT_ID is not configured"); });
    const res = await GET();
    expect(res.status).toBe(503);
  });
});
