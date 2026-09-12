import { describe, expect, it } from "vitest";
import { buildProxyProviderPolicy } from "@/lib/ai-proxy/provider-policy";

describe("AI proxy provider policy", () => {
  it("builds approved provider lists by quality, cost, latency, and region", () => {
    expect(buildProxyProviderPolicy({ qualityPolicy: "cheap" }).allowedProviders[0]).toBe("openrouter");
    expect(buildProxyProviderPolicy({ qualityPolicy: "best" }).allowedProviders[0]).toBe("anthropic");
    expect(buildProxyProviderPolicy({ region: "eu" }).allowedProviders).toContain("mistral");
    expect(buildProxyProviderPolicy({ latencyBudgetMs: 400 }).allowedProviders[0]).toBe("openai");
    expect(buildProxyProviderPolicy({ maxCostCents: 0 }).allowedProviders).toEqual(["openrouter"]);
  });
});
