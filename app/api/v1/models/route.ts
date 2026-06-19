import { NextResponse } from "next/server";
import { buildApiOnlyTierDescriptor, listOpenAiCompatibleModels } from "@/lib/ai-proxy/access-tier";
import { checkPublicRateLimit, ipFromHeaders, rateLimitExceeded } from "@/lib/rate-limit";

export async function GET(request: Request) {
  const limit = await checkPublicRateLimit(ipFromHeaders(request.headers), "v1:models");
  if (!limit.ok) return rateLimitExceeded(limit.retryAfterSeconds);

  return NextResponse.json({
    ...listOpenAiCompatibleModels(),
    trent: buildApiOnlyTierDescriptor(),
  });
}
