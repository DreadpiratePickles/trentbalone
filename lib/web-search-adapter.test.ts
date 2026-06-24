import { describe, expect, it, vi } from "vitest";
import { createWebSearchAdapter, parseTavilyResults } from "./web-search-adapter";

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as unknown as Response;
}

describe("Web Search adapter", () => {
  it("fails closed without credentials instead of returning mocked results", async () => {
    const fetchImpl = vi.fn();
    const adapter = createWebSearchAdapter({ env: {}, fetchImpl });

    await expect(adapter.healthCheck()).resolves.toBe("needs_credentials");
    expect(adapter.availability).toBe("real");

    const result = await adapter.execute("search", { query: "best ICP for devtools" });
    expect(result.status).toBe("failed");
    expect(result.summary).toContain("TAVILY_API_KEY");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reports connected with a credential and never gates research on approval", async () => {
    const adapter = createWebSearchAdapter({ env: { TAVILY_API_KEY: "tvly-abc123" }, fetchImpl: vi.fn() });
    await expect(adapter.healthCheck()).resolves.toBe("connected");
    expect(adapter.requiresApproval("search")).toBe(false);
    expect(adapter.estimateCost()).toBe(0);
  });

  it("requires a query", async () => {
    const fetchImpl = vi.fn();
    const adapter = createWebSearchAdapter({ env: { TAVILY_API_KEY: "tvly-abc123" }, fetchImpl });
    const result = await adapter.execute("search", {});
    expect(result.status).toBe("failed");
    expect(result.summary).toContain("payload.query");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("performs a real search and summarizes the answer + sources", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({
      answer: "PostHog and Sentry lead the devtools analytics ICP.",
      results: [
        { title: "Devtools ICP guide", url: "https://example.com/icp", content: "...", score: 0.9 },
        { title: "Analytics buyers", url: "https://example.com/buyers", content: "...", score: 0.8 },
      ],
    }));
    const adapter = createWebSearchAdapter({ env: { TAVILY_API_KEY: "tvly-abc123" }, fetchImpl });

    const result = await adapter.execute("search", { query: "devtools ICP", maxResults: 25 });
    expect(result.status).toBe("completed");
    expect(result.summary).toContain("PostHog and Sentry");
    expect(result.summary).toContain("https://example.com/icp");

    // maxResults is clamped to the ceiling (10), not the requested 25.
    const body = JSON.parse((fetchImpl.mock.calls[0][1] as RequestInit).body as string);
    expect(body.max_results).toBe(10);
    expect(body.include_answer).toBe(true);
  });

  it("surfaces rejected credentials distinctly", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}, false, 401));
    const adapter = createWebSearchAdapter({ env: { TAVILY_API_KEY: "tvly-bad" }, fetchImpl });
    const result = await adapter.execute("search", { query: "x" });
    expect(result.status).toBe("failed");
    expect(result.summary).toContain("TAVILY_API_KEY");
  });

  it("parseTavilyResults drops malformed entries and trims the answer", () => {
    const parsed = parseTavilyResults({
      answer: "  hi  ",
      results: [
        { title: "ok", url: "https://a.com", content: "c", score: 0.5 },
        { title: "no url" },
        "garbage",
      ],
    });
    expect(parsed.answer).toBe("hi");
    expect(parsed.results).toHaveLength(1);
    expect(parsed.results[0].url).toBe("https://a.com");
  });
});
