import { semanticCacheKey } from "@/lib/model-gateway";

const cache = new Map<string, unknown>();

export function buildSmartCacheKey(input: { companyId: string; endpoint: string; prompt: string }): string {
  return semanticCacheKey({ companyId: input.companyId, taskType: input.endpoint, prompt: input.prompt });
}

export function isSmartCacheRequested(headers: Headers, body: unknown): boolean {
  if (headers.get("x-trent-smart-cache")?.toLowerCase() === "true") return true;
  const record = body && typeof body === "object" ? body as Record<string, unknown> : {};
  const metadata = record.metadata && typeof record.metadata === "object" ? record.metadata as Record<string, unknown> : {};
  return metadata.smart_cache === true;
}

export async function getSmartCache<T = unknown>(key: string): Promise<T | null> {
  return cache.has(key) ? cache.get(key) as T : null;
}

export async function setSmartCache(key: string, value: unknown): Promise<void> {
  cache.set(key, value);
}

export function resetSmartCacheForTest(): void {
  cache.clear();
}
