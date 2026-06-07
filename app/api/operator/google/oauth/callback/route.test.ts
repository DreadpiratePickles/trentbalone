import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetAuthUser, mockIsOperator, mockExchange, mockSave } = vi.hoisted(() => ({
  mockGetAuthUser: vi.fn(),
  mockIsOperator: vi.fn(),
  mockExchange: vi.fn(),
  mockSave: vi.fn(),
}));

vi.mock("@/lib/session", () => ({
  getAuthUser: mockGetAuthUser,
  unauthorized: () => new Response("unauthorized", { status: 401 }),
  forbidden: () => new Response("forbidden", { status: 403 }),
}));
vi.mock("@/lib/google/operator-auth", () => ({ isOperator: mockIsOperator }));
vi.mock("@/lib/google/google-oauth", () => ({ exchangeCodeForTokens: mockExchange }));
vi.mock("@/lib/google/google-connection", () => ({ saveGoogleConnection: mockSave }));

import { GET } from "./route";

function req(query: string) {
  return new Request(`http://x/api/operator/google/oauth/callback${query}`);
}

describe("/api/operator/google/oauth/callback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAuthUser.mockResolvedValue({ id: "user_1", email: "boss@trent.app" });
    mockIsOperator.mockReturnValue(true);
    mockExchange.mockResolvedValue({ refreshToken: "rt_new", scopes: ["gmail.send"] });
    mockSave.mockResolvedValue({});
  });

  it("rejects a missing code", async () => {
    const res = await GET(req(""));
    expect(res.status).toBe(400);
  });

  it("surfaces a Google denial", async () => {
    const res = await GET(req("?error=access_denied"));
    expect(res.status).toBe(400);
  });

  it("exchanges the code and saves the connection", async () => {
    const res = await GET(req("?code=auth_1&state=s1"));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.connected).toBe(true);
    expect(mockExchange).toHaveBeenCalledWith("auth_1");
    expect(mockSave).toHaveBeenCalledWith({ refreshToken: "rt_new", scopes: ["gmail.send"] });
  });

  it("returns 502 when the exchange fails", async () => {
    mockExchange.mockRejectedValue(new Error("token exchange failed"));
    const res = await GET(req("?code=auth_1"));
    expect(res.status).toBe(502);
  });
});
