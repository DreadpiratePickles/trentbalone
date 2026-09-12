import { beforeEach, describe, expect, it } from "vitest";
import {
  buildSmartCacheKey,
  getSmartCache,
  isSmartCacheRequested,
  resetSmartCacheForTest,
  setSmartCache,
} from "@/lib/ai-proxy/smart-cache";

describe("AI proxy smart cache", () => {
  beforeEach(() => resetSmartCacheForTest());

  it("builds company-scoped semantic keys without raw prompt leakage", () => {
    const key = buildSmartCacheKey({
      companyId: "co_1",
      endpoint: "chat.completions",
      prompt: "secret customer@example.com",
    });

    expect(key).toMatch(/^semcache_/);
    expect(key).not.toContain("customer@example.com");
  });

  it("is bypassed unless explicitly requested", () => {
    expect(isSmartCacheRequested(new Headers(), {})).toBe(false);
    expect(isSmartCacheRequested(new Headers({ "x-trent-smart-cache": "true" }), {})).toBe(true);
    expect(isSmartCacheRequested(new Headers(), { metadata: { smart_cache: true } })).toBe(true);
  });

  it("stores and returns cache hits scoped by key", async () => {
    const key = buildSmartCacheKey({ companyId: "co_1", endpoint: "chat.completions", prompt: "hello" });
    await setSmartCache(key, { id: "chatcmpl_1" });

    expect(await getSmartCache(key)).toEqual({ id: "chatcmpl_1" });
    expect(await getSmartCache(`${key}_other`)).toBeNull();
  });
});
