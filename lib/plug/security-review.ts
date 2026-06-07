import type { PlugDefinition } from "@/lib/plug/schema-v2";

export type PlugSecurityReview = {
  status: "approved" | "blocked" | "manual_review_required";
  findings: string[];
};

export function reviewPlugSecurity(plug: PlugDefinition): PlugSecurityReview {
  const findings: string[] = [];
  if (plug.publisher.ownershipHistory.some((event) => !event.reviewed)) findings.push("ownership_transfer_unreviewed");
  if (plug.declaredTools.some((tool) => tool.allowedActions.includes("charge") && !tool.approvalRequiredActions.includes("charge"))) {
    findings.push("money_action_without_approval");
  }
  return { status: findings.length ? "manual_review_required" : "approved", findings };
}
