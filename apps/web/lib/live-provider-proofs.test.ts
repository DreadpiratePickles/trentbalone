import { describe, expect, it, vi } from "vitest";
import { runLiveProviderProofs } from "@/lib/live-provider-proofs";

describe("live provider proofs", () => {
  it("runs configured read-only provider checks without leaking secrets", async () => {
    const fetchImpl = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = String(input);
      if (url === "https://api.attio.com/v2/objects") {
        return json({ data: [{ id: { object_id: "obj_1" }, api_slug: "companies" }] });
      }
      if (url === "https://api.resend.com/domains") {
        return json({ data: [{ name: "let-trent.uk", status: "verified" }] });
      }
      if (url === "https://api.stripe.com/v1/balance") {
        return json({ available: [{ amount: 1234, currency: "usd" }], pending: [] });
      }
      if (url === "https://us.posthog.com/api/projects/123/query/") {
        expect(init?.method).toBe("POST");
        return json({ results: [["$pageview", 17]] });
      }
      if (url === "https://api.x.com/2/users/me") {
        return json({ data: { id: "user_1", username: "LiveWops" } });
      }
      if (url === "https://api.github.com/repos/wopslive-agent/trent") {
        return json({ full_name: "wopslive-agent/trent", private: true });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const report = await runLiveProviderProofs({
      env: {
        ATTIO_TOKEN: "attio_secret",
        ATTIO_WORKSPACE_URL: "https://app.attio.com/example",
        RESEND_API_KEY: "re_secret",
        RESEND_FROM_DOMAIN: "let-trent.uk",
        STRIPE_SECRET_KEY: "sk_test_secret",
        POSTHOG_PERSONAL_API_KEY: "phx_secret",
        POSTHOG_PROJECT_ID: "123",
        X_USER_ACCESS_TOKEN: "xox_secret",
        GITHUB_TOKEN: "ghp_secret",
        GITHUB_OWNER: "wopslive-agent",
        GITHUB_REPO: "trent",
      },
      fetchImpl,
    });

    expect(report.summary).toMatchObject({
      total: expect.any(Number),
      passed: 6,
      failed: 0,
    });
    expect(report.proofs.find((proof) => proof.key === "sentry")?.status).toBe("skipped");
    expect(report.proofs.find((proof) => proof.key === "resend")?.evidence).toMatchObject({
      configuredDomain: "let-trent.uk",
      configuredDomainStatus: "verified",
    });
    expect(report.proofs.find((proof) => proof.key === "x")?.evidence).toMatchObject({
      username: "LiveWops",
    });
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("attio_secret");
    expect(serialized).not.toContain("re_secret");
    expect(serialized).not.toContain("sk_test_secret");
    expect(serialized).not.toContain("phx_secret");
    expect(serialized).not.toContain("xox_secret");
    expect(serialized).not.toContain("ghp_secret");
  });

  it("fails configured providers honestly when the live API rejects the credential", async () => {
    const fetchImpl = vi.fn(async () => json({ errors: [{ message: "Credits depleted" }] }, 402));

    const report = await runLiveProviderProofs({
      env: { X_USER_ACCESS_TOKEN: "x_user_secret" },
      fetchImpl,
      providers: ["x"],
    });

    expect(report.summary).toMatchObject({ total: 1, passed: 0, failed: 1, skipped: 0 });
    expect(report.proofs[0]).toMatchObject({
      key: "x",
      status: "failed",
      httpStatus: 402,
      recovery: expect.stringContaining("X"),
    });
    expect(JSON.stringify(report)).not.toContain("x_user_secret");
  });

  it("rejects malformed bearer credentials before making a live request", async () => {
    const fetchImpl = vi.fn();

    const report = await runLiveProviderProofs({
      env: { STRIPE_SECRET_KEY: "sk_bad\u0441" },
      fetchImpl,
      providers: ["stripe"],
    });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(report.summary).toMatchObject({ total: 1, passed: 0, failed: 1 });
    expect(report.proofs[0].error).toContain("malformed");
    expect(JSON.stringify(report)).not.toContain("sk_bad");
  });
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
