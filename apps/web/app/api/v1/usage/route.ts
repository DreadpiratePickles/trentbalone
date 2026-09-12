import { NextResponse } from "next/server";
import { authenticateProxyApiKey } from "@/lib/ai-proxy/api-keys";
import { summarizeProxyUsage } from "@/lib/ai-proxy/analytics";
import { withRlsContext } from "@/lib/with-rls";

export async function GET(request: Request) {
  const auth = await authenticateProxyApiKey(request.headers.get("authorization"));
  if (!auth || !auth.scopes.includes("usage")) {
    return NextResponse.json({ error: "invalid_api_key" }, { status: 401 });
  }

  const since = new URL(request.url).searchParams.get("since") ?? undefined;
  return withRlsContext(auth.companyId, async () => {
    const summary = await summarizeProxyUsage(auth.companyId, { keyId: auth.keyId, since });
    return NextResponse.json({ summary });
  });
}
