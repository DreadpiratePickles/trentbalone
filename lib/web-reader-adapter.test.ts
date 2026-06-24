import { describe, expect, it, vi } from "vitest";
import { createWebReaderAdapter } from "./web-reader-adapter";

function textResponse(body: string, ok = true, status = 200): Response {
  return { ok, status, text: async () => body } as unknown as Response;
}

describe("Web Reader adapter", () => {
  it("is available with no credentials (free tier) and never approval-gates", async () => {
    const adapter = createWebReaderAdapter({ env: {}, fetchImpl: vi.fn() });
    await expect(adapter.healthCheck()).resolves.toBe("connected");
    expect(adapter.availability).toBe("real");
    expect(adapter.requiresApproval("read")).toBe(false);
    expect(adapter.estimateCost()).toBe(0);
  });

  it("rejects non-http(s) urls", async () => {
    const fetchImpl = vi.fn();
    const adapter = createWebReaderAdapter({ env: {}, fetchImpl });
    const result = await adapter.execute("read", { url: "ftp://example.com" });
    expect(result.status).toBe("failed");
    expect(result.summary).toContain("payload.url");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reads a page as markdown via Jina Reader", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(textResponse("# Pricing\n\nPlans start at $0."));
    const adapter = createWebReaderAdapter({ env: {}, fetchImpl });

    const result = await adapter.execute("read", { url: "https://example.com/pricing" });
    expect(result.status).toBe("completed");
    expect(result.summary).toContain("# Pricing");

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://r.jina.ai/https://example.com/pricing");
    // No Authorization header without a key.
    expect((init as RequestInit).headers).not.toHaveProperty("Authorization");
  });

  it("adds Authorization when JINA_API_KEY is set", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(textResponse("content"));
    const adapter = createWebReaderAdapter({ env: { JINA_API_KEY: "jina-abc" }, fetchImpl });
    await adapter.execute("fetch", { url: "https://example.com" });
    const headers = (fetchImpl.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer jina-abc");
  });

  it("fails when the page cannot be fetched", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(textResponse("", false, 502));
    const adapter = createWebReaderAdapter({ env: {}, fetchImpl });
    const result = await adapter.execute("read", { url: "https://example.com" });
    expect(result.status).toBe("failed");
    expect(result.summary).toContain("502");
  });
});
