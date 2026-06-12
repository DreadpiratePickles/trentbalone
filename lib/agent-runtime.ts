import {
  buildSlotEnvironment,
  getCatalogAgent,
  getCatalogAgentV3,
  AGENT_CATALOG,
  SLOT_CONTRACTS
} from "@/lib/agent-catalog";
import { loadGrantedSkillInstructions } from "@/lib/agent-skill-instructions";
import { agentSystemPrompt } from "@/lib/agents";
import { store } from "@/lib/store";
import type { AgentEnvironmentConfig, AgentRole } from "@/lib/types";
import { logger } from "@/lib/logger";
import { buildSeatSystemPrompt } from "@/lib/seat-manifest";
import { buildOperatingStateBundle } from "@/lib/operating-state";
import { providerReadinessSnapshot } from "@/lib/provider-readiness";

export type AgentRuntime = {
  role: AgentRole;
  slotContract: (typeof SLOT_CONTRACTS)[AgentRole];
  profile?: ReturnType<typeof getCatalogAgent>;
  v3Profile?: ReturnType<typeof getCatalogAgentV3>;
  availableV3Profiles?: Array<NonNullable<ReturnType<typeof getCatalogAgentV3>>>;
  environment: AgentEnvironmentConfig;
  staticPrompt: string;
  dynamicPrompt: string;
  systemPrompt: string;
};

const runtimeCache = new Map<string, AgentRuntime>();
let runtimeHits = 0;
const GROWTH_REQUIRED_SKILLS = ["hyperframes", "hyperframes-cli"];

function uniqueStable(values: string[]): string[] {
  return Array.from(new Set(values));
}

export function clearAgentRuntimeCache() {
  runtimeCache.clear();
  runtimeHits = 0;
}

export function getAgentRuntimeCacheStats() {
  return {
    runtimeEntries: runtimeCache.size,
    runtimeHits,
  };
}

export async function getAgentRuntime(companyId: string, role: AgentRole): Promise<AgentRuntime> {
  const cacheKey = `${companyId}:${role}`;
  const cached = runtimeCache.get(cacheKey);
  if (cached) {
    runtimeHits++;
    return cached;
  }

  const assignment = await store.getAgentPlugAssignment(companyId, role);
  const profile = getCatalogAgent(assignment?.profileId);
  const v3Profile = getCatalogAgentV3(assignment?.profileId);
  const availableV3Profiles = AGENT_CATALOG.map((agent) => getCatalogAgentV3(agent.id))
    .filter((agent): agent is NonNullable<ReturnType<typeof getCatalogAgentV3>> => !!agent);
  const environment = assignment?.environment ?? buildSlotEnvironment(companyId, role);
  const grantedSkills = uniqueStable([
    ...(role === "growth" ? GROWTH_REQUIRED_SKILLS : []),
    ...(environment.skills ?? profile?.skills ?? []),
  ]);
  const skillInstructionBlocks = grantedSkills.length > 0
    ? await loadGrantedSkillInstructions(grantedSkills)
    : [];
  
  // Clone slot contract so we can modify it safely
  const slotContract = { ...SLOT_CONTRACTS[role] };
  
  let basePrompt = agentSystemPrompt(role);

  if (profile) {
    // Override default agent prompt to focus on the custom profile specialty
    const base = "You are part of Trent, an original AI cofounder operating system. Produce concise, auditable, structured startup work. Never claim to send emails, spend money, merge code, launch ads, or publish externally without approval.";
    basePrompt = [
      base,
      `Act as the plugged specialist profile: ${v3Profile?.name ?? profile.name}.`,
      `Specialties: ${profile.specialties}`,
      `When to use: ${profile.whenToUse}`,
      v3Profile?.whenNotToUse ? `When not to use: ${v3Profile.whenNotToUse}` : "",
      v3Profile?.specialistPrompt ?? "",
    ].filter(Boolean).join("\n\n");
    
    // Override/enrich mission contract to apply specialties to the role
    slotContract.mission = `Applying your specialties (${profile.specialties}), your mission as the ${role} agent is: ${slotContract.mission}`;
  }

  const profileBlock = profile
    ? [
        `Plugged profile: ${profile.name}`,
        `Source: agency-agents/${profile.file}`,
        `Specialties: ${profile.specialties}`,
        `When to use: ${profile.whenToUse}`
      ].join("\n")
    : "Plugged profile: Trent default slot persona";

  const outcomeSnapshotBlock = await buildRuntimeOutcomeSnapshot(companyId, role);

  const environmentBlock = [
    `Memory namespace: ${environment.memoryNamespace}`,
    `Allowed tools: ${environment.tools.join(", ") || "none"}`,
    `Approval required for: ${environment.approvalRequiredFor.join(", ") || "none"}`,
    `Budget per run: ${environment.budgetCentsPerRun} cents`,
    `Max runtime: ${environment.maxRuntimeSeconds} seconds`,
    `Required outputs: ${environment.outputContract.join(", ")}`,
    `Granted skills: ${grantedSkills.join(", ") || "none"}`
  ].join("\n");

  const contractBlock = [
    `Slot mission: ${slotContract.mission}`,
    `Inputs: ${slotContract.inputs.join(", ")}`,
    `Deliverables: ${slotContract.deliverables.join(", ")}`,
    `Success metrics: ${slotContract.successMetrics.join(", ")}`
  ].join("\n");

  const staticPrompt = [...skillInstructionBlocks, basePrompt, buildSeatSystemPrompt(role)].join("\n\n");
  const dynamicPrompt = [contractBlock, profileBlock, outcomeSnapshotBlock, environmentBlock].filter(Boolean).join("\n\n");

  const runtime = {
    role,
    slotContract,
    profile,
    v3Profile,
    availableV3Profiles,
    environment,
    staticPrompt,
    dynamicPrompt,
    systemPrompt: [staticPrompt, dynamicPrompt].join("\n\n")
  };
  runtimeCache.set(cacheKey, runtime);
  logger.debug({ agentRole: role, profileId: profile?.id ?? null, toolCount: environment.tools.length }, "agent.runtime_built");
  return runtime;
}

async function buildRuntimeOutcomeSnapshot(companyId: string, role: AgentRole): Promise<string> {
  if (role !== "ceo" && role !== "analyst") return "";

  const company = await store.getCompany(companyId).catch(() => null);
  const state = company
    ? await buildOperatingStateBundle(company, `Runtime outcome snapshot for ${role}`).catch(() => null)
    : null;
  const readiness = providerReadinessSnapshot()
    .map((item) => `- ${item.label}: ${item.status}${item.recovery ? ` (${item.recovery})` : ""}`)
    .join("\n");

  return [
    "OUTCOME SNAPSHOT",
    "Use this as real operating context. Do not invent missing external metrics; call an available provider tool or state that the provider is not configured.",
    state?.text ?? "Operating state unavailable.",
    "PROVIDER READINESS",
    readiness || "- none",
  ].join("\n");
}
