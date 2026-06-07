import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetAuthUser, mockIsOperator, mockCheckRateLimit, mockIngest } = vi.hoisted(() => ({
  mockGetAuthUser: vi.fn(),
  mockIsOperator: vi.fn(),
  mockCheckRateLimit: vi.fn(),
  mockIngest: vi.fn(),
}));

vi.mock("@/lib/session", () => ({
  getAuthUser: mockGetAuthUser,
  unauthorized: () => new Response("unauthorized", { status: 401 }),
  forbidden: () => new Response("forbidden", { status: 403 }),
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: mockCheckRateLimit,
  rateLimitExceeded: () => new Response("rate limited", { status: 429 }),
}));
vi.mock("@/lib/google/operator-auth", () => ({ isOperator: mockIsOperator }));
vi.mock("@/lib/google/google-memory", () => ({ ingestGoogleContext: mockIngest }));
vi.mock("@/lib/google/google-connection", () => ({ OPERATOR_SCOPE: "operator" }));

import { POST } from "./route";

const RESULT = { status: "ingested", documentId: "doc_1", emailCount: 3, eventCount: 2, sidecar: "not_connected" };

function req(body: unknown) {
  return new Request("http://x/api/operator/google/ingest", { method: "POST", body: JSON.stringify(body) });
}

describe("/api/operator/google/ingest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAuthUser.mockResolvedValue({ id: "user_1", email: "boss@trent.app" });
    mockIsOperator.mockReturnValue(true);
    mockCheckRateLimit.mockResolvedValue({ ok: true });
    mockIngest.mockResolvedValue(RESULT);
  });

  it("returns 403 for non-operators", async () => {
    mockIsOperator.mockReturnValue(false);
    const res = await POST(req({}));
    expect(res.status).toBe(403);
  });

  it("returns 429 when rate limited", async () => {
    mockCheckRateLimit.mockResolvedValue({ ok: false, retryAfterSeconds: 30 });
    const res = await POST(req({}));
    expect(res.status).toBe(429);
  });

  it("ingests Google context for the operator", async () => {
    const res = await POST(req({ emailLimit: 5 }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.result).toEqual(RESULT);
    expect(mockIngest).toHaveBeenCalledWith({ emailLimit: 5, eventLimit: undefined });
  });
});
