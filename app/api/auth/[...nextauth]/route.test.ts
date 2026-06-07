import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockCheckAuthRateLimit, mockRateLimitExceeded } = vi.hoisted(() => ({
  mockCheckAuthRateLimit: vi.fn(),
  mockRateLimitExceeded: vi.fn(() => new Response("rate limited", { status: 429 })),
}));

vi.mock("@/lib/rate-limit", () => ({
  checkAuthRateLimit: mockCheckAuthRateLimit,
  rateLimitExceeded: mockRateLimitExceeded,
}));

vi.mock("@/lib/auth", () => ({
  handlers: {
    GET: vi.fn(async () => new Response("ok", { status: 200 })),
    POST: vi.fn(async () => new Response("ok", { status: 200 })),
  },
}));

import { GET, POST } from "./route";

beforeEach(() => {
  mockCheckAuthRateLimit.mockReset();
  mockRateLimitExceeded.mockReturnValue(new Response("rate limited", { status: 429 }));
});

describe("Auth route rate limiting", () => {
  it("GET passes through without consuming the brute-force auth bucket", async () => {
    const req = new Request("http://x/api/auth/session", {
      headers: { "x-forwarded-for": "1.2.3.4" },
    });
    const res = await GET(req as never, { params: Promise.resolve({}) } as never);
    expect(res.status).toBe(200);
    expect(mockCheckAuthRateLimit).not.toHaveBeenCalled();
  });

  it("POST returns 429 when IP limit exceeded", async () => {
    mockCheckAuthRateLimit.mockResolvedValue({ ok: false, retryAfterSeconds: 45 });
    const req = new Request("http://x/api/auth/signin", {
      method: "POST",
      headers: { "x-forwarded-for": "1.2.3.4" },
    });
    const res = await POST(req as never, { params: Promise.resolve({}) } as never);
    expect(res.status).toBe(429);
    expect(mockRateLimitExceeded).toHaveBeenCalledWith(45);
  });

  it("POST falls back to 'unknown' IP when header absent", async () => {
    mockCheckAuthRateLimit.mockResolvedValue({ ok: true });
    const req = new Request("http://x/api/auth/session");
    await POST(req as never, { params: Promise.resolve({}) } as never);
    expect(mockCheckAuthRateLimit).toHaveBeenCalledWith("unknown");
  });
});
