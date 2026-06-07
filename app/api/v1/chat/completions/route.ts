import { NextResponse } from "next/server";
import { authenticateProxyApiKey, assertProxyQuotaAvailable, recordProxyUsage } from "@/lib/ai-proxy/api-keys";
import { buildChatCompletion, normalizeChatRequest, StreamingNotSupportedError } from "@/lib/ai-proxy/openai-compatible";
import { buildSmartCacheKey, getSmartCache, isSmartCacheRequested, setSmartCache } from "@/lib/ai-proxy/smart-cache";
import { checkRateLimit, rateLimitExceeded } from "@/lib/rate-limit";
import { withRlsContext } from "@/lib/with-rls";

export async function POST(request: Request) {
  const auth = await authenticateProxyApiKey(request.headers.get("authorization"));
  if (!auth || !auth.scopes.includes("chat")) {
    return NextResponse.json({ error: "invalid_api_key" }, { status: 401 });
  }

  const rateLimit = await checkRateLimit(auth.keyId, auth.companyId);
  if (!rateLimit.ok) return rateLimitExceeded(rateLimit.retryAfterSeconds);

  const body = await request.json().catch(() => ({}));
  let normalized;
  try {
    normalized = normalizeChatRequest(body);
  } catch (error) {
    const message = error instanceof StreamingNotSupportedError ? error.message : "invalid_chat_request";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  const cacheRequested = isSmartCacheRequested(request.headers, body);
  const cacheKey = buildSmartCacheKey({ companyId: auth.companyId, endpoint: "chat.completions", prompt: normalized.prompt });
  if (cacheRequested) {
    const cached = await getSmartCache<Record<string, unknown>>(cacheKey);
    if (cached) return NextResponse.json(cached, { headers: { "x-trent-cache": "hit" } });
  }

  const quota = await assertProxyQuotaAvailable(auth, { tokens: normalized.prompt.length });
  if (!quota.ok) {
    return NextResponse.json(
      { error: "quota_exceeded", retryAfterSeconds: quota.retryAfterSeconds },
      { status: 429, headers: { "Retry-After": String(quota.retryAfterSeconds) } }
    );
  }

  return withRlsContext(auth.companyId, async () => {
    const completion = await buildChatCompletion({ companyId: auth.companyId, request: normalized });
    await recordProxyUsage(auth, {
      endpoint: "chat.completions",
      provider: completion.route.provider,
      model: normalized.model,
      inputTokens: completion.inputTokens,
      outputTokens: completion.outputTokens,
      amountCents: completion.amountCents,
    });
    if (cacheRequested) await setSmartCache(cacheKey, completion.response);
    return NextResponse.json(completion.response);
  });
}
