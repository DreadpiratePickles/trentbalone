import { NextResponse } from "next/server";
import { z } from "zod";
import { refreshPlatformOAuthConnection, type PlatformOAuthPlatform } from "@/lib/platform-oauth";
import { checkRateLimit, rateLimitExceeded } from "@/lib/rate-limit";
import { isMarketingPlatform } from "@/lib/marketing/platform-adapter";
import { forbidden, getAuthUser, requireRoleForRequest, unauthorized } from "@/lib/session";
import { isSocialPlatform } from "@/lib/social/platform-adapter";
import { withRlsContext } from "@/lib/with-rls";

const refreshSchema = z.object({
  companyId: z.string().min(1),
  kind: z.enum(["social", "ads"]),
  platform: z.string().min(1),
});

export async function POST(request: Request) {
  const user = await getAuthUser();
  if (!user) return unauthorized();

  const parsed = refreshSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid OAuth refresh request", issues: parsed.error.flatten() }, { status: 400 });
  }
  const platform = parseOAuthPlatform(parsed.data.kind, parsed.data.platform);
  if (!platform) return NextResponse.json({ error: "Unsupported OAuth platform" }, { status: 400 });

  const check = await requireRoleForRequest(user.id, "admin", { companyId: parsed.data.companyId });
  if (!check.ok) return forbidden();
  const limit = await checkRateLimit(user.id, parsed.data.companyId);
  if (!limit.ok) return rateLimitExceeded(limit.retryAfterSeconds);

  return withRlsContext(parsed.data.companyId, async () => {
    try {
      const result = await refreshPlatformOAuthConnection({ ...parsed.data, platform });
      return NextResponse.json({ result });
    } catch (error) {
      return NextResponse.json({
        error: "OAuth refresh failed",
        detail: error instanceof Error ? error.message : "Unknown OAuth refresh failure",
      }, { status: 400 });
    }
  });
}

function parseOAuthPlatform(kind: "social" | "ads", value: string): PlatformOAuthPlatform | undefined {
  if (kind === "social" && isSocialPlatform(value)) return value;
  if (kind === "ads" && isMarketingPlatform(value)) return value;
  return undefined;
}
