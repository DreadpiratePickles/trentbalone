import { describe, expect, it, vi } from "vitest";
import { createSentryReadAdapter, summarizeSentryIssues } from "./sentry-read-adapter";

describe("Sentry read adapter", () => {
  it("fails closed without token or org instead of returning mocked diagnostics", async () => {
    const adapter = createSentryReadAdapter({ env: {}, fetchImpl: vi.fn() });

    await expect(adapter.healthCheck()).resolves.toBe("needs_credentials");
    expect(adapter.availability).toBe("unavailable");

    const result = await adapter.execute("read_issues", {});
    expect(result.status).toBe("failed");
    expect(result.summary).toContain("SENTRY_AUTH_TOKEN");
    expect(result.summary).not.toMatch(/mock/i);
  });

  it("reads unresolved issues from Sentry without approval", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify([
      { id: "1", shortId: "APP-1", title: "TypeError: boom", level: "error", count: "12", userCount: 5, permalink: "https://sentry.io/issues/1" },
      { id: "2", shortId: "APP-2", title: "Warning: slow", level: "warning", count: "3", userCount: 1, permalink: "https://sentry.io/issues/2" },
    ]), { status: 200 }));
    const adapter = createSentryReadAdapter({
      env: { SENTRY_AUTH_TOKEN: "sntrys_secret", SENTRY_ORG: "trent", SENTRY_PROJECT: "app" },
      fetchImpl,
    });

    expect(adapter.availability).toBe("real");
    expect(adapter.requiresApproval("read_issues")).toBe(false);
    const result = await adapter.execute("read_issues", {});

    expect(fetchImpl).toHaveBeenCalledWith("https://sentry.io/api/0/organizations/trent/issues/?query=is%3Aunresolved&limit=25&project=app", expect.objectContaining({
      method: "GET",
      headers: expect.objectContaining({ Authorization: "Bearer sntrys_secret" }),
    }));
    expect(result.status).toBe("completed");
    expect(result.summary).toContain("2 unresolved issues");
    expect(result.summary).toContain("APP-1");
    expect(result.summary).not.toContain("sntrys_secret");
  });

  it("discovers the Sentry organization when a token can access exactly one org", async () => {
    const fetchImpl = vi.fn(async (input: URL | RequestInfo) => {
      const url = String(input);
      if (url === "https://sentry.io/api/0/organizations/") {
        return new Response(JSON.stringify([{ slug: "trent-discovered" }]), { status: 200 });
      }
      return new Response(JSON.stringify([
        { id: "1", shortId: "APP-1", title: "TypeError: boom", level: "error", count: "12", userCount: 5 },
      ]), { status: 200 });
    });
    const adapter = createSentryReadAdapter({
      env: { SENTRY_AUTH_TOKEN: "sntrys_secret" },
      fetchImpl,
    });

    expect(adapter.availability).toBe("real");
    await expect(adapter.healthCheck()).resolves.toBe("connected");
    const result = await adapter.execute("read_issues", {});

    expect(fetchImpl).toHaveBeenCalledWith("https://sentry.io/api/0/organizations/", expect.objectContaining({
      method: "GET",
      headers: expect.objectContaining({ Authorization: "Bearer sntrys_secret" }),
    }));
    expect(fetchImpl).toHaveBeenCalledWith("https://sentry.io/api/0/organizations/trent-discovered/issues/?query=is%3Aunresolved&limit=25", expect.any(Object));
    expect(result.status).toBe("completed");
    expect(result.summary).toContain("1 unresolved issue");
  });

  it("requires an explicit Sentry org when discovery is ambiguous", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify([
      { slug: "one" },
      { slug: "two" },
    ]), { status: 200 }));
    const adapter = createSentryReadAdapter({
      env: { SENTRY_AUTH_TOKEN: "sntrys_secret" },
      fetchImpl,
    });

    await expect(adapter.healthCheck()).resolves.toBe("needs_credentials");
    const result = await adapter.execute("read_issues", {});

    expect(result.status).toBe("failed");
    expect(result.summary).toContain("Set SENTRY_ORG explicitly");
    expect(result.summary).not.toContain("sntrys_secret");
  });

  it("refuses mutating issue actions from the agent tool path", async () => {
    const adapter = createSentryReadAdapter({
      env: { SENTRY_AUTH_TOKEN: "sntrys_secret", SENTRY_ORG: "trent" },
      fetchImpl: vi.fn(),
    });

    expect(adapter.requiresApproval("resolve issue")).toBe(true);
    const result = await adapter.execute("resolve issue", { approvalId: "approval_1" });

    expect(result.status).toBe("failed");
    expect(result.summary).toContain("read-only");
  });
});

describe("summarizeSentryIssues", () => {
  it("formats top issues by count without leaking payload details", () => {
    const summary = summarizeSentryIssues([
      { shortId: "APP-2", title: "Second", count: "3", level: "warning", userCount: 1 },
      { shortId: "APP-1", title: "First", count: "12", level: "error", userCount: 5 },
    ]);

    expect(summary).toContain("2 unresolved issues");
    expect(summary).toContain("APP-1");
    expect(summary.indexOf("APP-1")).toBeLessThan(summary.indexOf("APP-2"));
  });
});
