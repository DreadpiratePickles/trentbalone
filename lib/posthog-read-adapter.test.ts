import { describe, expect, it, vi } from "vitest";
import { createPostHogReadAdapter, summarizePostHogSnapshot } from "./posthog-read-adapter";

describe("PostHog read adapter", () => {
  it("fails closed without token or project id instead of returning mocked analytics", async () => {
    const adapter = createPostHogReadAdapter({ env: {}, fetchImpl: vi.fn() });

    await expect(adapter.healthCheck()).resolves.toBe("needs_credentials");
    expect(adapter.availability).toBe("real");

    const result = await adapter.execute("read_metrics", {});
    expect(result.status).toBe("failed");
    expect(result.summary).toContain("POSTHOG_PERSONAL_API_KEY");
    expect(result.summary).toContain("POSTHOG_PROJECT_ID");
    expect(result.summary).not.toMatch(/mock/i);
  });

  it("reads recent analytics through PostHog HogQL without approval", async () => {
    let requestInit: RequestInit | undefined;
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      requestInit = init;
      return new Response(JSON.stringify({
      results: [
        ["$pageview", 42],
        ["signup_completed", 7],
      ],
    }), { status: 200 });
    });
    const adapter = createPostHogReadAdapter({
      env: {
        POSTHOG_PERSONAL_API_KEY: "phx_secret",
        POSTHOG_PROJECT_ID: "12345",
        POSTHOG_HOST: "https://us.posthog.com",
      },
      fetchImpl,
    });

    expect(adapter.availability).toBe("real");
    expect(adapter.requiresApproval("read_metrics")).toBe(false);
    const result = await adapter.execute("read_metrics", { days: 14 });

    expect(fetchImpl).toHaveBeenCalledWith("https://us.posthog.com/api/projects/12345/query/", expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({ Authorization: "Bearer phx_secret" }),
    }));
    const body = JSON.parse(String(requestInit?.body));
    expect(body.query.kind).toBe("HogQLQuery");
    expect(body.query.query).toContain("interval 14 day");
    expect(result.status).toBe("completed");
    expect(result.summary).toContain("$pageview: 42");
    expect(result.summary).not.toContain("phx_secret");
  });

  it("refuses analytics write actions from the agent tool path", async () => {
    const adapter = createPostHogReadAdapter({
      env: { POSTHOG_PERSONAL_API_KEY: "phx_secret", POSTHOG_PROJECT_ID: "12345" },
      fetchImpl: vi.fn(),
    });

    expect(adapter.requiresApproval("delete event")).toBe(true);
    const result = await adapter.execute("delete event", { approvalId: "approval_1" });

    expect(result.status).toBe("failed");
    expect(result.summary).toContain("read-only");
  });
});

describe("summarizePostHogSnapshot", () => {
  it("formats event counts without leaking raw payload details", () => {
    const summary = summarizePostHogSnapshot([
      ["signup_completed", 7],
      ["$pageview", 42],
    ]);

    expect(summary).toContain("2 PostHog event rows");
    expect(summary).toContain("$pageview: 42");
    expect(summary.indexOf("$pageview")).toBeLessThan(summary.indexOf("signup_completed"));
  });
});
