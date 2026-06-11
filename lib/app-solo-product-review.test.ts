import { describe, expect, it } from "vitest";
import { buildAppSoloProductReview } from "./app-solo-product-review";

describe("buildAppSoloProductReview", () => {
  it("summarizes App-Solo delivery readiness without an MCP dependency", () => {
    expect(buildAppSoloProductReview({
      appSolo: {
        deliverables: ["working preview"],
        approvalGates: ["gmail.send"],
      },
      evidenceSummary: {
        status: "failing",
        passCount: 0,
        failCount: 1,
        skipCount: 0,
        failedChecks: ["tests"],
        fileCount: 0,
        screenshotCount: 0,
        artifactCount: 0,
        commandCount: 2,
        failedCommandCount: 0,
        previewCaptured: false,
      },
    })).toMatchObject({
      status: "needs_attention",
      deliverables: ["working preview"],
      approvalGates: ["gmail.send"],
      reviewSignals: {
        verification: "failing",
        preview: "missing",
        artifacts: "missing",
        commands: "completed",
      },
      guidance: [
        { type: "failed_verification", checks: ["tests"] },
        { type: "missing_preview" },
        { type: "missing_artifacts" },
      ],
    });
  });
});
