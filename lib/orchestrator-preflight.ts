import { getCompanyAutonomySettings } from "@/lib/autonomy-settings";
import { buildConnectorMatrix, type ConnectorMatrix } from "@/lib/connector-matrix";
import { providerReadinessSnapshot, type ProviderReadiness } from "@/lib/provider-readiness";
import { nowIso } from "@/lib/utils";
import type { Company } from "@/lib/types";

export type OrchestratorPreflightMemoryCounts = {
  documents: number;
  episodic: number;
  semantic: number;
  workbenchArtifacts: number;
};

export type OrchestratorPreflightSnapshot = {
  generatedAt: string;
  autonomy: ReturnType<typeof getCompanyAutonomySettings>;
  providers: ProviderReadiness[];
  connectors: ConnectorMatrix;
  toolReadiness: {
    connected: number;
    needsCredentials: number;
    failed: number;
    approvalRequired: number;
  };
  memory: OrchestratorPreflightMemoryCounts & {
    totalSources: number;
  };
  budget: {
    weeklyBudgetCents: number;
    fallbackBudgetCents: number;
  };
  approvalPolicy: {
    externalWrites: "approval_required" | "not_required";
    spend: "approval_required" | "not_required";
    blockedToolScopes: string[];
    allowlistedToolScopes: string[];
  };
};

export function buildOrchestratorPreflightSnapshot(input: {
  company: Pick<Company, "id" | "brief" | "autonomyLevel" | "weeklyBudgetCents" | "budgetCents">;
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  memorySourceCounts?: Partial<OrchestratorPreflightMemoryCounts>;
  mcpServerCount?: number;
}): OrchestratorPreflightSnapshot {
  const env = (input.env ?? process.env) as NodeJS.ProcessEnv;
  const autonomy = getCompanyAutonomySettings(input.company);
  const providers = providerReadinessSnapshot(env);
  const connectors = buildConnectorMatrix({ env, mcpServerCount: input.mcpServerCount ?? 0 });
  const memory = {
    documents: input.memorySourceCounts?.documents ?? 0,
    episodic: input.memorySourceCounts?.episodic ?? 0,
    semantic: input.memorySourceCounts?.semantic ?? 0,
    workbenchArtifacts: input.memorySourceCounts?.workbenchArtifacts ?? 0,
  };

  return {
    generatedAt: nowIso(),
    autonomy,
    providers,
    connectors,
    toolReadiness: {
      connected: connectors.summary.connected,
      needsCredentials: connectors.summary.needsCredentials,
      failed: connectors.summary.failed,
      approvalRequired: connectors.summary.approvalRequired,
    },
    memory: {
      ...memory,
      totalSources: memory.documents + memory.episodic + memory.semantic + memory.workbenchArtifacts,
    },
    budget: {
      weeklyBudgetCents: input.company.weeklyBudgetCents ?? 0,
      fallbackBudgetCents: input.company.budgetCents ?? 0,
    },
    approvalPolicy: {
      externalWrites: autonomy.approvalRequiredForExternalWrites ? "approval_required" : "not_required",
      spend: autonomy.approvalRequiredForSpend ? "approval_required" : "not_required",
      blockedToolScopes: autonomy.blockedToolScopes,
      allowlistedToolScopes: autonomy.allowlistedToolScopes,
    },
  };
}
