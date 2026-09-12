import { describe, expect, it } from "vitest";
import { buildMcpWorkbenchProductReview } from "./product-review";

describe("buildMcpWorkbenchProductReview", () => {
  it("marks failed App-Solo evidence as needing attention with actionable guidance", () => {
    expect(buildMcpWorkbenchProductReview({
      metadata: {
        appSolo: {
          deliverables: ["campaign draft"],
          approvalGates: ["hyperframes.publish"],
        },
      },
      evidenceSummary: evidence({
        status: "failing",
        failCount: 1,
        failedChecks: ["tests"],
        artifactCount: 2,
        previewCaptured: true,
      }),
    })).toEqual({
      status: "needs_attention",
      deliverables: ["campaign draft"],
      approvalGates: ["hyperframes.publish"],
      reviewSignals: {
        verification: "failing",
        preview: "captured",
        artifacts: "present",
        commands: "completed",
      },
      guidance: [{ type: "failed_verification", checks: ["tests"] }],
    });
  });

  it("returns incomplete guidance when preview and artifacts are missing", () => {
    expect(buildMcpWorkbenchProductReview({
      metadata: {},
      evidenceSummary: evidence({
        status: "missing",
        commandCount: 0,
        artifactCount: 0,
        previewCaptured: false,
      }),
    })).toMatchObject({
      status: "incomplete",
      reviewSignals: {
        verification: "missing",
        preview: "missing",
        artifacts: "missing",
        commands: "not_recorded",
      },
      guidance: expect.arrayContaining([
        { type: "missing_verification" },
        { type: "missing_preview" },
        { type: "missing_artifacts" },
      ]),
    });
  });
});

function evidence(
  overrides: Partial<Parameters<typeof buildMcpWorkbenchProductReview>[0]["evidenceSummary"]>
): Parameters<typeof buildMcpWorkbenchProductReview>[0]["evidenceSummary"] {
  const base: Parameters<typeof buildMcpWorkbenchProductReview>[0]["evidenceSummary"] = {
    status: "passing",
    passCount: 1,
    failCount: 0,
    skipCount: 0,
    failedChecks: [],
    fileCount: 1,
    screenshotCount: 0,
    artifactCount: 1,
    commandCount: 1,
    failedCommandCount: 0,
    previewCaptured: true,
    previewUrl: "https://preview.example.test",
  };
  return { ...base, ...overrides };
}
