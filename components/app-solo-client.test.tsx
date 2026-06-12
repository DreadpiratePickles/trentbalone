import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AppSoloClient, AppSoloRunSummaryPanel } from "@/components/app-solo-client";

describe("AppSoloClient", () => {
  it("renders the selected agent contract in the live trace panel", () => {
    const html = renderToStaticMarkup(<AppSoloClient companyId="co_1" />);

    expect(html).toContain("agent contract");
    expect(html).toContain("Growth / Marketing");
    expect(html).toContain("Steel Browser");
    expect(html).toContain("mode");
    expect(html).toContain("design");
    expect(html).toContain("scopes");
    expect(html).toContain("steel:");
    expect(html).toContain("deliverables");
    expect(html).toContain("experiment backlog");
    expect(html).toContain("approval gates");
    expect(html).toContain("gmail.send");
    expect(html).toContain("evidence");
    expect(html).toContain("verification, preview, artifacts, commands");
    expect(html).toContain("data-testid=\"app-solo-provider-e2b\"");
    expect(html).toContain("data-testid=\"app-solo-start-run\"");
  });

  it("renders the final solo run summary with evidence counts and failed checks", () => {
    const html = renderToStaticMarkup(
      <AppSoloRunSummaryPanel
        summary={{
          status: "failed",
          fileCount: 2,
          commandCount: 3,
          files: [{ path: "src/App.tsx", action: "create", bytes: 420 }],
          commands: [{ command: "npm test", exitCode: 1 }],
          previewUrl: "http://localhost:4100",
          verification: {
            passed: false,
            passCount: 1,
            failCount: 1,
            skipCount: 1,
            failedChecks: ["tests"],
          },
        }}
      />,
    );

    expect(html).toContain("run summary");
    expect(html).toContain("failed");
    expect(html).toContain("2 files");
    expect(html).toContain("3 commands");
    expect(html).toContain("preview captured");
    expect(html).toContain("1 pass / 1 failed / 1 skipped");
    expect(html).toContain("failed: tests");
    expect(html).toContain("artifacts: src/App.tsx");
    expect(html).toContain("commands: npm test exit 1");
  });

  it("renders product readiness guidance for incomplete solo output", () => {
    const html = renderToStaticMarkup(
      <AppSoloRunSummaryPanel
        summary={{
          status: "failed",
          fileCount: 0,
          commandCount: 2,
          verification: {
            passed: false,
            passCount: 0,
            failCount: 1,
            skipCount: 0,
            failedChecks: ["tests"],
          },
        }}
      />,
    );

    expect(html).toContain("product readiness");
    expect(html).toContain("needs_attention");
    expect(html).toContain("verification failing");
    expect(html).toContain("preview missing");
    expect(html).toContain("artifacts missing");
    expect(html).toContain("guidance: failed_verification tests, missing_preview, missing_artifacts");
  });
});
