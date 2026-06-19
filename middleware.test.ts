import { beforeEach, describe, expect, it } from "vitest";
import { vi } from "vitest";

const { mockGetToken } = vi.hoisted(() => ({
  mockGetToken: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    next: () => new Response(null, { status: 200, headers: { "x-middleware-next": "1" } }),
    json: (body: unknown, init?: ResponseInit) => Response.json(body, init),
    redirect: (url: URL) => new Response(null, { status: 307, headers: { location: url.toString() } }),
  },
}));

vi.mock("next-auth/jwt", () => ({
  getToken: mockGetToken,
}));

import middleware from "./middleware";
import type { NextRequest } from "next/server";

function request(pathname: string, session = false): NextRequest {
  const url = new URL(`http://localhost:3000${pathname}`);
  return {
    nextUrl: url,
    cookies: {
      get: () => session ? { value: "session" } : undefined,
    },
  } as unknown as NextRequest;
}

describe("middleware", () => {
  beforeEach(() => {
    mockGetToken.mockReset();
    mockGetToken.mockResolvedValue(null);
  });

  it("lets /api/mcp reach its bearer-auth route without a browser session", async () => {
    const res = await middleware(request("/api/mcp"));

    expect(res.status).toBe(200);
    expect(res.headers.get("x-middleware-next")).toBe("1");
    expect(mockGetToken).not.toHaveBeenCalled();
  });

  it("still protects ordinary API routes without a browser session", async () => {
    const res = await middleware(request("/api/tasks"));

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "Unauthorized" });
  });

  it("rejects forged session-cookie presence without a valid JWT", async () => {
    const res = await middleware(request("/api/tasks", true));

    expect(mockGetToken).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(401);
  });

  it("allows ordinary API routes when Auth.js returns a valid token subject", async () => {
    mockGetToken.mockResolvedValue({ sub: "user_1" });

    const res = await middleware(request("/api/tasks", true));

    expect(res.status).toBe(200);
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });

  it("redirects protected pages to sign-in when the JWT is missing", async () => {
    const res = await middleware(request("/companies/co_1"));

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(
      "http://localhost:3000/auth/signin?callbackUrl=%2Fcompanies%2Fco_1"
    );
  });
});
