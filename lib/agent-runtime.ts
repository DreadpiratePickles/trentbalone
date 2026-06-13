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
import { SEAT_MANIFESTS } from "@/lib/seat-manifest";
import { buildOperatingStateBundle } from "@/lib/operating-state";
import { providerReadinessSnapshot } from "@/lib/provider-readiness";
import {
  applySeatCapabilityGate,
  buildSeatCapabilityGatePrompt,
  loadLatestSeatCapabilityGateDecision,
} from "@/lib/seat-capability-gating";

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

type CachedAgentRuntime = {
  runtime: AgentRuntime;
  freshnessFingerprint: string;
};

const runtimeCache = new Map<string, CachedAgentRuntime>();
let runtimeHits = 0;

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
  const freshnessFingerprint = await buildRuntimeFreshnessFingerprint(companyId);
  const cached = runtimeCache.get(cacheKey);
  if (cached && cached.freshnessFingerprint === freshnessFingerprint) {
    runtimeHits++;
    return cached.runtime;
  }

  const assignment = await store.getAgentPlugAssignment(companyId, role);
  const profile = getCatalogAgent(assignment?.profileId);
  const v3Profile = getCatalogAgentV3(assignment?.profileId);
  const availableV3Profiles = AGENT_CATALOG.map((agent) => getCatalogAgentV3(agent.id))
    .filter((agent): agent is NonNullable<ReturnType<typeof getCatalogAgentV3>> => !!agent);
  const baseEnvironment = assignment?.environment ?? buildSlotEnvironment(companyId, role);
  const capabilityGateDecision = await loadLatestSeatCapabilityGateDecision(companyId, role).catch(() => undefined);
  const environment = applySeatCapabilityGate(baseEnvironment, capabilityGateDecision);
  const grantedSkills = uniqueStable([
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

  const memoryPlanBlock = await buildMemoryPlanBlock(companyId, role, profile);
  const outcomeSnapshotBlock = await buildRuntimeOutcomeSnapshot(companyId, role);
  const capabilityGateBlock = buildSeatCapabilityGatePrompt(capabilityGateDecision);

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
  const dynamicPrompt = [contractBlock, profileBlock, memoryPlanBlock, outcomeSnapshotBlock, capabilityGateBlock, environmentBlock].filter(Boolean).join("\n\n");

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
  runtimeCache.set(cacheKey, { runtime, freshnessFingerprint });
  logger.debug({ agentRole: role, profileId: profile?.id ?? null, toolCount: environment.tools.length }, "agent.runtime_built");
  return runtime;
}

async function buildRuntimeFreshnessFingerprint(companyId: string): Promise<string> {
  const documents = await store.listDocuments(companyId).catch(() => []);
  return documents
    .map((doc) => [
      doc.id,
      doc.version ?? 0,
      doc.memoryTier ?? "",
      doc.validFrom ?? "",
      doc.validTo ?? "",
    ].join(":"))
    .sort()
    .join("|");
}

async function buildMemoryPlanBlock(
  companyId: string,
  role: AgentRole,
  profile?: ReturnType<typeof getCatalogAgent>,
): Promise<string> {
  const manifestPlan = SEAT_MANIFESTS[role].memory;
  const profilePlan = profile?.memoryPlan;
  const readPlans = [
    ...manifestPlan.readsOnStart,
    ...(profilePlan ? [{ tier: "semantic" as const, keys: profilePlan.readsOnStart }] : []),
  ];
  const writePlans = [
    ...manifestPlan.writesOnFinish,
    ...(profilePlan ? [{ tier: "episodic" as const, keys: profilePlan.writesOnFinish }] : []),
  ];
  const readKeys = uniqueStable(readPlans.flatMap((plan) => plan.keys));
  const writeKeys = uniqueStable(writePlans.flatMap((plan) => plan.keys));
  const documents = await store.listDocuments(companyId).catch(() => []);
  const relevant = documents
    .filter((doc) => {
      const tierMatches = readPlans.some((plan) => !doc.memoryTier || doc.memoryTier === plan.tier);
      if (!tierMatches) return false;
      const haystack = `${doc.type} ${doc.title} ${doc.source} ${doc.content}`.toLowerCase();
      return readKeys.some((key) => haystack.includes(key.toLowerCase()))
        || (role === "ceo" && haystack.includes("ceo decision journal"));
    })
    .slice(0, 6);

  return [
    "MEMORY PLAN",
    `Namespace: ${manifestPlan.namespaceTemplate.replace("{companyId}", companyId)}`,
    `readsOnStart: ${readKeys.join(", ") || "none"}`,
    relevant.length
      ? [
          "Recalled memory:",
          ...relevant.map((doc) => `- [${doc.id}] ${doc.title}: ${doc.content.slice(0, 240)}`),
        ].join("\n")
      : "Recalled memory: none",
    `writesOnFinish: ${writeKeys.join(", ") || "none"}`,
  ].join("\n");
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
