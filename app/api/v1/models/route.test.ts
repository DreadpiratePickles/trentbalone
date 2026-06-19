import { vi } from "vitest";
import { describe, expect, it } from "vitest";

const { mockCheckPublicRateLimit } = vi.hoisted(() => ({
  mockCheckPublicRateLimit: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock("@/lib/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rate-limit")>();
  return {
    ...actual,
    checkPublicRateLimit: mockCheckPublicRateLimit,
  };
});

import { GET } from "./route";

describe("/v1/models", () => {
  it("returns an OpenAI-compatible model list with Trent tier metadata", async () => {
    const res = await GET(new Request("http://x/api/v1/models", {
      headers: { "x-forwarded-for": "203.0.113.10, 10.0.0.1" },
    }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.object).toBe("list");
    expect(body.data.map((model: { id: string }) => model.id)).toContain("trent-sonnet");
    expect(body.trent.capabilities).toContain("chat.completions");
    expect(mockCheckPublicRateLimit).toHaveBeenCalledWith("203.0.113.10", "v1:models");
  });

  it("returns 429 when the public model listing bucket is exceeded", async () => {
    mockCheckPublicRateLimit.mockResolvedValueOnce({ ok: false, retryAfterSeconds: 12 });

    const res = await GET(new Request("http://x/api/v1/models"));

    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("12");
  });
});
