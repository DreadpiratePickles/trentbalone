import { NextResponse } from "next/server";
import { authenticateProxyApiKey, assertProxyQuotaAvailable, recordProxyUsage } from "@/lib/ai-proxy/api-keys";
import { buildEmbeddingResponse, normalizeEmbeddingRequest } from "@/lib/ai-proxy/embeddings";
import { checkRateLimit, rateLimitExceeded } from "@/lib/rate-limit";
import { withRlsContext } from "@/lib/with-rls";

export async function POST(request: Request) {
  const auth = await authenticateProxyApiKey(request.headers.get("authorization"));
  if (!auth || !auth.scopes.includes("embeddings")) {
    return NextResponse.json({ error: "invalid_api_key" }, { status: 401 });
  }

  const rateLimit = await checkRateLimit(auth.keyId, auth.companyId);
  if (!rateLimit.ok) return rateLimitExceeded(rateLimit.retryAfterSeconds);

  const body = await request.json().catch(() => ({}));
  let normalized;
  try {
    normalized = normalizeEmbeddingRequest(body);
  } catch {
    return NextResponse.json({ error: "invalid_embedding_request" }, { status: 400 });
  }

  const quota = await assertProxyQuotaAvailable(auth, { tokens: normalized.inputs.join(" ").length });
  if (!quota.ok) return NextResponse.json({ error: "quota_exceeded", retryAfterSeconds: quota.retryAfterSeconds }, { status: 429 });

  return withRlsContext(auth.companyId, async () => {
    const result = await buildEmbeddingResponse({ companyId: auth.companyId, request: normalized });
    await recordProxyUsage(auth, {
      endpoint: "embeddings",
      provider: result.route.provider,
      model: normalized.model,
      inputTokens: result.inputTokens,
      outputTokens: 0,
      amountCents: result.amountCents,
    });
    return NextResponse.json(result.response);
  });
}
