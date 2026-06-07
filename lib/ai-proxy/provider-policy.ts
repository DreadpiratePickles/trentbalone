import type { ModelProvider } from "@/lib/model-gateway";

export type ProxyQualityPolicy = "cheap" | "balanced" | "best";

export type ProxyProviderPolicyInput = {
  qualityPolicy?: ProxyQualityPolicy;
  maxCostCents?: number;
  latencyBudgetMs?: number;
  region?: "us" | "eu" | "global";
};

export function buildProxyProviderPolicy(input: ProxyProviderPolicyInput = {}): { allowedProviders: ModelProvider[] } {
  if (input.maxCostCents === 0) return { allowedProviders: ["openrouter"] };
  if (input.latencyBudgetMs && input.latencyBudgetMs <= 500) return { allowedProviders: ["openai", "anthropic", "openrouter"] };
  if (input.region === "eu") return { allowedProviders: ["mistral", "openai", "anthropic"] };
  if (input.qualityPolicy === "cheap") return { allowedProviders: ["openrouter", "mistral", "openai"] };
  if (input.qualityPolicy === "best") return { allowedProviders: ["anthropic", "openai", "google"] };
  return { allowedProviders: ["anthropic", "openai", "google", "mistral", "openrouter"] };
}
