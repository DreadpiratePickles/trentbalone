import { MODELS } from "@/lib/ai-client";
import type { ToolReadiness } from "@/lib/seat-tool-contracts";
import type { ActionProvenance } from "@/lib/trust-panel";
import type { Approval, Artifact } from "@/lib/types";

export type VerificationStatus = "passed" | "degraded" | "failed" | "credential_blocked";

export type TrustPanelEvidenceRow = {
  label: string;
  status: VerificationStatus;
  detail: string;
};

export type TrustPanelProviderEvidence = TrustPanelEvidenceRow & {
  provenance: ActionProvenance;
};

export type TrustPanelRunEvidence = {
  model: TrustPanelEvidenceRow;
  providers: TrustPanelProviderEvidence[];
  artifacts: TrustPanelEvidenceRow & { count: number };
  approvals: TrustPanelEvidenceRow & { pending: number; gated: number };
  memoryAudit: TrustPanelEvidenceRow & { auditCount: number };
  verification: TrustPanelEvidenceRow;
};

const STATUS_LABEL: Record<VerificationStatus, string> = {
  passed: "Passed",
  degraded: "Degraded",
  failed: "Failed",
  credential_blocked: "Credential blocked",
};

export function verificationStatusLabel(status: VerificationStatus): string {
  return STATUS_LABEL[status];
}

export function verificationStatusForReadiness(readiness: ToolReadiness): VerificationStatus {
  switch (readiness) {
    case "connected":
      return "passed";
    case "needs_credentials":
      return "credential_blocked";
    case "mocked":
      return "degraded";
    case "unavailable":
      return "failed";
    default:
      return "passed";
  }
}

export function buildTrustPanelRunEvidence(input: {
  modelName?: string;
  providerRows: TrustPanelProviderEvidence[];
  artifacts: Artifact[];
  approvals: Approval[];
  auditSummaries: string[];
  gatedActionCount: number;
  verificationStatus: VerificationStatus;
  verificationSummary: string;
}): TrustPanelRunEvidence {
  const pendingApprovals = input.approvals.filter((row) => row.status === "pending").length;
  const latestArtifact = input.artifacts[0];
  const artifactStatus: VerificationStatus = input.artifacts.length > 0 ? "passed" : "degraded";
  const approvalStatus: VerificationStatus = pendingApprovals > 0 ? "passed" : "degraded";
  const auditStatus: VerificationStatus = input.auditSummaries.length > 0 ? "passed" : "degraded";

  return {
    model: {
      label: input.modelName ?? MODELS.STRONG,
      status: "passed",
      detail: "Seat runtime model for this run",
    },
    providers: input.providerRows,
    artifacts: {
      label: "Artifacts",
      status: artifactStatus,
      detail: latestArtifact
        ? `${latestArtifact.title} (${latestArtifact.status})`
        : "No artifacts recorded for this company yet",
      count: input.artifacts.length,
    },
    approvals: {
      label: "Approvals",
      status: approvalStatus,
      detail: pendingApprovals > 0
        ? `${pendingApprovals} pending approval gate${pendingApprovals === 1 ? "" : "s"}`
        : "No pending approval gates",
      pending: pendingApprovals,
      gated: input.gatedActionCount,
    },
    memoryAudit: {
      label: "Memory / audit",
      status: auditStatus,
      detail: input.auditSummaries[0] ?? "No audit rows yet",
      auditCount: input.auditSummaries.length,
    },
    verification: {
      label: "Verification",
      status: input.verificationStatus,
      detail: input.verificationSummary,
    },
  };
}
