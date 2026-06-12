import { afterEach, describe, expect, it } from "vitest";
import { providerReadinessSnapshot, toolUnavailableResult } from "@/lib/provider-readiness";
import type { ToolAdapter } from "@/lib/tools";

const originalNodeEnv = process.env.NODE_ENV;
const originalE2bApiKey = process.env.E2B_API_KEY;
const originalDaytonaApiKey = process.env.DAYTONA_API_KEY;

afterEach(() => {
  (process.env as Record<string, string | undefined>).NODE_ENV = originalNodeEnv;
  (process.env as Record<string, string | undefined>).E2B_API_KEY = originalE2bApiKey;
  (process.env as Record<string, string | undefined>).DAYTONA_API_KEY = originalDaytonaApiKey;
});

describe("provider readiness", () => {
  it("marks mock_local sandbox as unavailable in production readiness", () => {
    (process.env as Record<string, string | undefined>).NODE_ENV = "production";
    delete (process.env as Record<string, string | undefined>).E2B_API_KEY;
    delete (process.env as Record<string, string | undefined>).DAYTONA_API_KEY;

    const snapshot = providerReadinessSnapshot();

    expect(snapshot.find((item) => item.key === "sandbox")?.status).toBe("unavailable");
    expect(snapshot.find((item) => item.key === "sandbox")?.recovery).toContain("E2B_API_KEY");
  });

  it("does not mark email real when only an API key is present", () => {
    const snapshot = providerReadinessSnapshot({
      RESEND_API_KEY: "re_test",
    } as unknown as NodeJS.ProcessEnv);

    expect(snapshot.find((item) => item.key === "email")).toMatchObject({
      status: "unavailable",
      recovery: expect.stringContaining("sender"),
    });
  });

  it("marks Resend email real when a token and platform domain are present", () => {
    const snapshot = providerReadinessSnapshot({
      RESEND_API_KEY: "re_test",
      RESEND_FROM_DOMAIN: "mail.trent.test",
    } as unknown as NodeJS.ProcessEnv);

    expect(snapshot.find((item) => item.key === "email")?.status).toBe("real");
  });

  it("marks malformed GitHub and Stripe credentials as failed readiness", () => {
    const snapshot = providerReadinessSnapshot({
      GITHUBTOKEN: "ghp_bad\u0441",
      STRIPE_SECRET_KEY: "sk_bad\u0441",
    } as unknown as NodeJS.ProcessEnv);

    expect(snapshot.find((item) => item.key === "github")).toMatchObject({
      status: "failed",
      recovery: expect.stringContaining("malformed"),
    });
    expect(snapshot.find((item) => item.key === "billing")).toMatchObject({
      status: "failed",
      recovery: expect.stringContaining("malformed"),
    });
  });

  it("returns an actionable failure for production test-only tools", () => {
    (process.env as Record<string, string | undefined>).NODE_ENV = "production";
    const adapter: ToolAdapter = {
      name: "Email",
      scopes: ["draft"],
      availability: "test_only",
      async healthCheck() { return "mocked"; },
      estimateCost() { return 0; },
      requiresApproval() { return false; },
      async execute() {
        throw new Error("should not execute");
      },
    };

    expect(toolUnavailableResult(adapter, "draft")).toMatchObject({
      adapter: "Email",
      action: "draft",
      status: "failed",
      summary: expect.stringContaining("not configured"),
    });
  });
});
