import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

const SESSION_COOKIE_NAMES = [
  "authjs.session-token",
  "__Secure-authjs.session-token",
  "next-auth.session-token",
  "__Secure-next-auth.session-token",
];

export default function middleware(req: NextRequest) {
  const isAuthorized = SESSION_COOKIE_NAMES.some((name) => !!req.cookies.get(name)?.value);
  const pathname = req.nextUrl.pathname;

  // Skip gating for public, auth, health, and cron routes
  if (
    pathname.startsWith("/api/auth") ||
    pathname.startsWith("/api/public") ||
    pathname.startsWith("/api/health") ||
    pathname.startsWith("/api/mcp") ||
    pathname.startsWith("/api/heartbeat/sweep") ||
    pathname.startsWith("/auth") ||
    pathname.startsWith("/public") ||
    pathname === "/"
  ) {
    return NextResponse.next();
  }

  // Protect all other company workspace and API paths
  if (!isAuthorized) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const signInUrl = new URL("/auth/signin", req.nextUrl.origin);
    signInUrl.searchParams.set("callbackUrl", pathname);
    return NextResponse.redirect(signInUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    "/companies/:path*",
    "/api/:path*"
  ]
};
