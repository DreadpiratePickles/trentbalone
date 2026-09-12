export const APP_SOLO_REVIEW_EVIDENCE = ["verification", "preview", "artifacts", "commands"] as const;

export type AppSoloProductEvidenceSummary = {
  status: "passing" | "failing" | "missing";
  passCount: number;
  failCount: number;
  skipCount: number;
  failedChecks: string[];
  fileCount: number;
  screenshotCount: number;
  artifactCount: number;
  commandCount: number;
  failedCommandCount: number;
  previewCaptured: boolean;
  previewUrl?: string;
};

export type AppSoloProductReviewInput = {
  appSolo?: {
    deliverables?: string[];
    approvalGates?: string[];
  };
  evidenceSummary: AppSoloProductEvidenceSummary;
};

export function buildAppSoloProductReview(input: AppSoloProductReviewInput) {
  const { appSolo, evidenceSummary } = input;
  return {
    status: productReviewStatus(evidenceSummary),
    deliverables: appSolo?.deliverables ?? [],
    approvalGates: appSolo?.approvalGates ?? [],
    reviewSignals: {
      verification: evidenceSummary.status,
      preview: evidenceSummary.previewCaptured ? "captured" : "missing",
      artifacts: evidenceSummary.artifactCount > 0 ? "present" : "missing",
      commands: commandSignal(evidenceSummary),
    },
    guidance: productReviewGuidance(evidenceSummary),
  };
}

function productReviewStatus(evidenceSummary: AppSoloProductEvidenceSummary) {
  if (evidenceSummary.failCount > 0 || evidenceSummary.failedCommandCount > 0) return "needs_attention";
  if (evidenceSummary.status === "missing" || !evidenceSummary.previewCaptured || evidenceSummary.artifactCount === 0) {
    return "incomplete";
  }
  return "ready_for_review";
}

function commandSignal(evidenceSummary: AppSoloProductEvidenceSummary) {
  if (evidenceSummary.failedCommandCount > 0) return "failing";
  if (evidenceSummary.commandCount > 0) return "completed";
  return "not_recorded";
}

function productReviewGuidance(evidenceSummary: AppSoloProductEvidenceSummary) {
  const guidance: Array<Record<string, unknown>> = [];
  if (evidenceSummary.failedChecks.length > 0) {
    guidance.push({ type: "failed_verification", checks: evidenceSummary.failedChecks });
  }
  if (evidenceSummary.failedCommandCount > 0) {
    guidance.push({ type: "failed_commands", count: evidenceSummary.failedCommandCount });
  }
  if (evidenceSummary.status === "missing") {
    guidance.push({ type: "missing_verification" });
  }
  if (!evidenceSummary.previewCaptured) {
    guidance.push({ type: "missing_preview" });
  }
  if (evidenceSummary.artifactCount === 0) {
    guidance.push({ type: "missing_artifacts" });
  }
  return guidance;
}
