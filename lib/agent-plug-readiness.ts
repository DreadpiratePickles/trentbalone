import { getCatalogAgentV3, type AgentSlot, type CatalogAgent } from "@/lib/agent-catalog";
import type { AgentEnvironmentConfig, AgentRole } from "@/lib/types";

export type AgentPlugReadinessReport = {
  ready: boolean;
  catalog: {
    totalProfiles: number;
    skillReadyProfiles: number;
    verificationReadyProfiles: number;
    evalReadyProfiles: number;
    capabilityRatedProfiles: number;
  };
  slots: {
    totalSlots: number;
    runtimeReadySlots: number;
  };
  issues: string[];
};

export function buildAgentPlugReadinessReport(input: {
  catalog: CatalogAgent[];
  slotDefinitions: AgentSlot[];
  environments: Partial<Record<AgentRole, AgentEnvironmentConfig>>;
}): AgentPlugReadinessReport {
  const issues: string[] = [];
  const skillReadyProfiles = input.catalog.filter((agent) => hasItems(agent.skills)).length;
  const verificationReadyProfiles = input.catalog.filter((agent) => agent.skills?.includes("verification-before-completion")).length;
  const v3Profiles = input.catalog.map((agent) => getCatalogAgentV3(agent.id) ?? agent);
  const evalReadyProfiles = v3Profiles.filter(hasEvalCoverage).length;
  const capabilityRatedProfiles = v3Profiles.filter((agent) => typeof agent.capability?.score === "number").length;
  if (skillReadyProfiles !== input.catalog.length) issues.push(`${input.catalog.length - skillReadyProfiles} catalog profiles have no skills`);
  if (verificationReadyProfiles !== input.catalog.length) issues.push(`${input.catalog.length - verificationReadyProfiles} catalog profiles lack verification discipline`);

  let runtimeReadySlots = 0;
  for (const slot of input.slotDefinitions) {
    const env = input.environments[slot.role];
    const slotIssues = slotReadinessIssues(slot.role, env);
    if (slotIssues.length === 0) runtimeReadySlots += 1;
    issues.push(...slotIssues);
  }

  return {
    ready: issues.length === 0,
    catalog: {
      totalProfiles: input.catalog.length,
      skillReadyProfiles,
      verificationReadyProfiles,
      evalReadyProfiles,
      capabilityRatedProfiles,
    },
    slots: {
      totalSlots: input.slotDefinitions.length,
      runtimeReadySlots,
    },
    issues,
  };
}

function hasEvalCoverage(agent: CatalogAgent): boolean {
  return hasItems(agent.evalSuite?.capability) || hasItems(agent.evalSuite?.regression);
}

function slotReadinessIssues(role: AgentRole, env?: AgentEnvironmentConfig): string[] {
  if (!env) return [`${role} slot has no environment`];
  const issues: string[] = [];
  if (!env.memoryNamespace) issues.push(`${role} slot has no memory namespace`);
  if (!hasItems(env.tools)) issues.push(`${role} slot has no tools`);
  if (!hasItems(env.approvalRequiredFor)) issues.push(`${role} slot has no approval gates`);
  if (!hasItems(env.outputContract)) issues.push(`${role} slot has no output contract`);
  if (!hasItems(env.skills)) issues.push(`${role} slot has no skills`);
  return issues;
}

function hasItems(value: unknown[] | undefined): boolean {
  return Array.isArray(value) && value.length > 0;
}
