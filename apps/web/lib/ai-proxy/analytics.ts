import { store } from "@/lib/store";

export type ProxyUsageSummary = {
  keyId: string;
  requestCount: number;
  inputTokens: number;
  outputTokens: number;
  amountCents: number;
  endpoints: Record<string, { requestCount: number; inputTokens: number; outputTokens: number; amountCents: number }>;
};

export async function summarizeProxyUsage(
  companyId: string,
  filter: { keyId: string; since?: string }
): Promise<ProxyUsageSummary> {
  const usage = await store.listUsage(companyId);
  const summary: ProxyUsageSummary = {
    keyId: filter.keyId,
    requestCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    amountCents: 0,
    endpoints: {},
  };

  for (const entry of usage) {
    if (entry.metadata.proxyKeyId !== filter.keyId) continue;
    if (filter.since && entry.createdAt < filter.since) continue;
    const endpoint = String(entry.metadata.endpoint ?? "unknown");
    const inputTokens = Number(entry.metadata.inputTokens ?? 0);
    const outputTokens = Number(entry.metadata.outputTokens ?? 0);
    summary.requestCount += 1;
    summary.inputTokens += inputTokens;
    summary.outputTokens += outputTokens;
    summary.amountCents += entry.amountCents;
    summary.endpoints[endpoint] ??= { requestCount: 0, inputTokens: 0, outputTokens: 0, amountCents: 0 };
    summary.endpoints[endpoint].requestCount += 1;
    summary.endpoints[endpoint].inputTokens += inputTokens;
    summary.endpoints[endpoint].outputTokens += outputTokens;
    summary.endpoints[endpoint].amountCents += entry.amountCents;
  }

  return summary;
}
