import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetAuthUser, mockIsOperator, mockGetStatus, mockRevoke } = vi.hoisted(() => ({
  mockGetAuthUser: vi.fn(),
  mockIsOperator: vi.fn(),
  mockGetStatus: vi.fn(),
  mockRevoke: vi.fn(),
}));

vi.mock("@/lib/session", () => ({
  getAuthUser: mockGetAuthUser,
  unauthorized: () => new Response("unauthorized", { status: 401 }),
  forbidden: () => new Response("forbidden", { status: 403 }),
}));

vi.mock("@/lib/google/operator-auth", () => ({ isOperator: mockIsOperator }));

vi.mock("@/lib/google/google-connection", () => ({
  getGoogleConnectionStatus: mockGetStatus,
  revokeGoogleConnection: mockRevoke,
}));

import { DELETE, GET } from "./route";

const STATUS = { provider: "Google", status: "connected", source: "operator", scopes: ["gmail.send"], refreshToken: "rt_…ed" };

describe("/api/operator/google", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAuthUser.mockResolvedValue({ id: "user_1", email: "boss@trent.app" });
    mockIsOperator.mockReturnValue(true);
    mockGetStatus.mockResolvedValue(STATUS);
    mockRevoke.mockResolvedValue(true);
  });

  it("GET returns 401 when unauthenticated", async () => {
    mockGetAuthUser.mockResolvedValue(null);
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it("GET returns 403 for a non-operator", async () => {
    mockIsOperator.mockReturnValue(false);
    const res = await GET();
    expect(res.status).toBe(403);
  });

  it("GET returns the connection status for the operator", async () => {
    const res = await GET();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.connection).toEqual(STATUS);
  });

  it("DELETE revokes the connection", async () => {
    const res = await DELETE();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.revoked).toBe(true);
    expect(mockRevoke).toHaveBeenCalled();
  });
});
