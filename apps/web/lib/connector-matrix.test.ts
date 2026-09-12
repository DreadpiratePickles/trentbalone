import { describe, expect, it } from "vitest";
import { buildConnectorMatrix } from "@/lib/connector-matrix";

describe("buildConnectorMatrix", () => {
  it("reports the required provider matrix with honest statuses and next actions", () => {
    const matrix = buildConnectorMatrix({
      env: {
        GITHUB_TOKEN: "ghp_valid",
        STRIPE_SECRET_KEY: "sk_test_valid",
        RESEND_API_KEY: "re_valid",
        RESEND_FROM_DOMAIN: "let-trent.uk",
        ATTIO_TOKEN: "attio_valid",
        ATTIO_WORKSPACE_URL: "https://app.attio.com/example",
        DATABASE_URL: "postgres://trent",
        DAYTONA_API_KEY: "daytona_valid",
      } as unknown as NodeJS.ProcessEnv,
      proofStatuses: new Map([
        ["github", { status: "passed", detail: "private import proof passed" }],
        ["stripe", { status: "failed", detail: "Stripe proof rejected token" }],
      ]),
      mcpServerCount: 1,
    });

    expect(matrix.rows.map((row) => row.key)).toEqual([
      "github",
      "stripe",
      "posthog",
      "sentry",
      "resend",
      "attio",
      "mcp",
      "database",
      "deploy",
      "sandbox",
      "browser",
    ]);
    expect(matrix.rows.find((row) => row.key === "github")).toMatchObject({
      status: "connected",
      proofStatus: "passed",
      proofDetail: "private import proof passed",
      approvalPolicy: "approval required for writes",
    });
    expect(matrix.rows.find((row) => row.key === "stripe")).toMatchObject({
      status: "failed",
      proofStatus: "failed",
      proofDetail: "Stripe proof rejected token",
    });
    expect(matrix.rows.find((row) => row.key === "posthog")?.status).toBe("needs_credentials");
    expect(matrix.rows.find((row) => row.key === "mcp")).toMatchObject({
      status: "connected",
      proofStatus: "not_recorded",
    });
    expect(matrix.summary.connected).toBeGreaterThan(0);
    expect(matrix.summary.failed).toBe(1);
    expect(matrix.summary.needsCredentials).toBeGreaterThan(0);
  });
});
