import { describe, expect, it } from "vitest";
import { vi } from "vitest";

vi.mock("next/server", () => ({
  NextResponse: {
    next: () => new Response(null, { status: 200, headers: { "x-middleware-next": "1" } }),
    json: (body: unknown, init?: ResponseInit) => Response.json(body, init),
    redirect: (url: URL) => new Response(null, { status: 307, headers: { location: url.toString() } }),
  },
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
  it("lets /api/mcp reach its bearer-auth route without a browser session", () => {
    const res = middleware(request("/api/mcp"));

    expect(res.status).toBe(200);
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });

  it("still protects ordinary API routes without a browser session", async () => {
    const res = middleware(request("/api/tasks"));

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "Unauthorized" });
  });
});
