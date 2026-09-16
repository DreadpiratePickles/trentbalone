import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getToken } from "next-auth/jwt";
import { authSessionCookieName, usesSecureAuthCookies } from "@/lib/auth-cookies";

export default async function middleware(req: NextRequest) {
  const pathname = req.nextUrl.pathname;

  // Skip gating for public, auth, health, cron, and bearer-secret inbound webhook routes
  if (
    pathname.startsWith("/api/auth") ||
    pathname.startsWith("/api/public") ||
    pathname.startsWith("/api/health") ||
    pathname.startsWith("/api/mcp") ||
    pathname.startsWith("/api/hooks/") ||
    pathname.startsWith("/api/heartbeat/sweep") ||
    pathname.startsWith("/auth") ||
    pathname.startsWith("/public") ||
    pathname === "/"
  ) {
    return NextResponse.next();
  }

  const token = await getToken({
    req,
    secret: process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET,
    secureCookie: usesSecureAuthCookies(),
    cookieName: authSessionCookieName(),
  }).catch(() => null);
  const isAuthorized = Boolean(token?.sub);

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
