import { buildAppSoloProductReview, type AppSoloProductEvidenceSummary } from "@/lib/app-solo-product-review";

export type McpWorkbenchEvidenceSummary = AppSoloProductEvidenceSummary;

export type McpWorkbenchProductReviewInput = {
  metadata: {
    appSolo?: {
      deliverables?: string[];
      approvalGates?: string[];
    };
  };
  evidenceSummary: McpWorkbenchEvidenceSummary;
};

export function buildMcpWorkbenchProductReview(input: McpWorkbenchProductReviewInput) {
  const { evidenceSummary, metadata } = input;
  return buildAppSoloProductReview({
    appSolo: metadata.appSolo,
    evidenceSummary,
  });
}
