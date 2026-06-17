import { MODELS } from "@/lib/ai-client";
import { buildArtifactDraft } from "@/lib/artifacts";
import { contractsForSeat, resolveSeatToolContracts } from "@/lib/seat-tool-contracts";
import {
  buildTrustPanelRunEvidence,
  type TrustPanelProviderEvidence,
  type VerificationStatus,
  verificationStatusForReadiness,
} from "@/lib/trust-panel-evidence";
import { buildTrustPanel, provenanceForReadiness, type TrustPanel } from "@/lib/trust-panel";
import { store } from "@/lib/store";
import type { AgentRole, ToolCallRecord } from "@/lib/types";
import { makeId, nowIso } from "@/lib/utils";

export type TrustPanelScenario = "clean" | "blocked";

export type TrustPanelView = TrustPanel & {
  scenario: TrustPanelScenario;
  seat: AgentRole;
  runEvidence: ReturnType<typeof buildTrustPanelRunEvidence>;
};

export async function buildTrustPanelView(input: {
  companyId: string;
  scenario?: TrustPanelScenario;
  seat?: AgentRole;
}): Promise<TrustPanelView> {
  const scenario = input.scenario ?? "clean";
  const seat = input.seat ?? "growth";
  const company = await store.getCompany(input.companyId);
  if (!company) throw new Error(`Company not found: ${input.companyId}`);

  const contracts = contractsForSeat(await resolveSeatToolContracts(input.companyId), seat);
  const [artifacts, approvals, audits] = await Promise.all([
    store.listArtifacts(input.companyId),
    store.listApprovals(input.companyId),
    store.listAuditLogs(input.companyId),
  ]);

  const toolCalls: ToolCallRecord[] = scenario === "clean"
    ? contracts
        .filter((contract) => contract.readiness === "connected")
        .slice(0, 1)
        .map((contract) => ({
          adapter: contract.resolvedAdapter ?? contract.tool,
          action: "read",
          status: "completed" as const,
          summary: "Live provider read completed in this run",
        }))
    : [];

  const output = scenario === "blocked"
    ? { summary: "I sent the launch announcement email to the founder list." }
    : { summary: "Reviewed connected providers and drafted the next operating actions." };

  const panel = buildTrustPanel({ contracts, toolCalls, output });
  const providerRows: TrustPanelProviderEvidence[] = contracts
    .filter((contract) => contract.advertised)
    .slice(0, 8)
    .map((contract) => {
      const executed = toolCalls.some(
        (call) =>
          call.status === "completed"
          && (call.adapter === contract.resolvedAdapter || call.adapter === contract.tool),
      );
      const provenance = provenanceForReadiness(contract.readiness, executed);
      return {
        label: contract.tool,
        status: verificationStatusForReadiness(contract.readiness),
        detail: contract.approvalRequired ? "Approval gated" : "Observed this run",
        provenance,
      };
    });

  const verificationStatus: VerificationStatus = panel.noUnverifiedClaims ? "passed" : "failed";
  const runEvidence = buildTrustPanelRunEvidence({
    modelName: artifacts[0]?.provenance.model ?? MODELS.STRONG,
    providerRows,
    artifacts,
    approvals,
    auditSummaries: audits.map((row) => row.summary),
    gatedActionCount: contracts.filter((contract) => contract.approvalRequired).length,
    verificationStatus,
    verificationSummary: panel.noUnverifiedClaims
      ? "Claim guard clean — no unverified tool claims in final output"
      : `${panel.violations.length} unverified claim(s) blocked from showing as done`,
  });

  return { ...panel, scenario, seat, runEvidence };
}

export async function seedTrustPanelProofEvidence(companyId: string): Promise<void> {
  const company = await store.getCompany(companyId);
  if (!company) throw new Error(`Company not found: ${companyId}`);

  const existingArtifacts = await store.listArtifacts(companyId);
  if (existingArtifacts.length === 0) {
    const draft = buildArtifactDraft({
      company,
      prompt: "Trust panel proof — operating cycle research artifact",
      type: "competitive_research",
      tasks: [],
      cycles: [],
      documents: [],
      reports: [],
    });
    await store.createArtifact({
      ...draft,
      provenance: {
        ...draft.provenance,
        model: MODELS.STRONG,
        generatedAt: nowIso(),
      },
    });
  }

  const existingApprovals = await store.listApprovals(companyId);
  if (!existingApprovals.some((row) => row.action.includes("Resend"))) {
    await store.createApproval({
      companyId,
      action: "Resend: founder onboarding email",
      reason: "Outbound email requires founder approval before send",
      toolName: "Resend",
      previewKind: "email",
      previewContent: "Subject: Welcome to your Trent operating cycle",
    });
  }

  const audits = await store.listAuditLogs(companyId);
  if (!audits.some((row) => row.action === "memory.write")) {
    await store.addAudit(
      companyId,
      "agent",
      "memory.write",
      "memory",
      makeId("memory"),
      "growth seat recorded experiment outcome for compounding recall",
    );
  }
}
