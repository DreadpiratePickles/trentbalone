import { handlers } from "@/lib/auth";
import { type NextRequest } from "next/server";
import { checkAuthRateLimit, rateLimitExceeded } from "@/lib/rate-limit";

type NextAuthCtx = { params: Promise<Record<string, string | string[]>> };

export async function GET(req: NextRequest, _ctx: NextAuthCtx) {
  return handlers.GET(req);
}

export async function POST(req: NextRequest, _ctx: NextAuthCtx) {
  const ip = req.headers.get("x-forwarded-for") ?? "unknown";
  const limit = await checkAuthRateLimit(ip);
  if (!limit.ok) return rateLimitExceeded(limit.retryAfterSeconds);
  return handlers.POST(req);
}
