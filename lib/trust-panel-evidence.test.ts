import { describe, expect, it } from "vitest";
import { buildTrustPanelRunEvidence, verificationStatusForReadiness } from "@/lib/trust-panel-evidence";

describe("buildTrustPanelRunEvidence", () => {
  it("maps provider readiness to verification status labels", () => {
    expect(verificationStatusForReadiness("connected")).toBe("passed");
    expect(verificationStatusForReadiness("needs_credentials")).toBe("credential_blocked");
    expect(verificationStatusForReadiness("mocked")).toBe("degraded");
    expect(verificationStatusForReadiness("unavailable")).toBe("failed");
  });

  it("builds run evidence rows for model, artifacts, approvals, audit, and verification", () => {
    const evidence = buildTrustPanelRunEvidence({
      modelName: "gpt-5.2",
      providerRows: [
        {
          label: "Stripe",
          status: "passed",
          detail: "Observed this run",
          provenance: "real",
        },
        {
          label: "Resend",
          status: "credential_blocked",
          detail: "Approval gated",
          provenance: "needs_credentials",
        },
      ],
      artifacts: [{
        id: "artifact_test",
        companyId: "company_test",
        title: "Research artifact",
        summary: "Proof artifact",
        type: "competitive_research",
        status: "ready",
        content: "content",
        exportFormat: "markdown",
        createdByAgent: "analyst",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        provenance: {
          model: "gpt-5.2",
          prompt: "test",
          generatedAt: new Date().toISOString(),
          sources: [],
          tokens: 100,
          costCents: 0,
        },
      }],
      approvals: [{
        id: "approval_test",
        companyId: "company_test",
        action: "Resend: founder email",
        reason: "needs approval",
        status: "pending",
        createdAt: new Date().toISOString(),
      }],
      auditSummaries: ["growth seat recorded experiment outcome for compounding recall"],
      gatedActionCount: 2,
      verificationStatus: "failed",
      verificationSummary: "1 unverified claim blocked",
    });

    expect(evidence.model.label).toBe("gpt-5.2");
    expect(evidence.providers).toHaveLength(2);
    expect(evidence.artifacts.count).toBe(1);
    expect(evidence.approvals.pending).toBe(1);
    expect(evidence.memoryAudit.auditCount).toBe(1);
    expect(evidence.verification.status).toBe("failed");
  });
});
