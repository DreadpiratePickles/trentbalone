import { authenticateProxyApiKey } from "@/lib/ai-proxy/api-keys";
import type { ProxyScope } from "@/lib/ai-proxy/types";
import type { McpAuthContext } from "./types";

export async function authenticateMcpRequest(
  authorization: string | null | undefined,
  requiredScope: ProxyScope = "mcp"
): Promise<McpAuthContext | null> {
  const auth = await authenticateProxyApiKey(authorization);
  if (!auth) return null;
  if (!auth.scopes.includes(requiredScope)) return null;
  return {
    companyId: auth.companyId,
    keyId: auth.keyId,
    maskedKey: auth.maskedKey,
    scopes: auth.scopes,
    tier: auth.tier,
  };
}
