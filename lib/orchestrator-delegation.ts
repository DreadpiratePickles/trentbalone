import type { WorkRequest } from "@/lib/planner";
import type { AgentRole } from "@/lib/types";
import type { StepRecord } from "@/lib/orchestrator-runtime";
import { routeCapabilityToRole } from "@/lib/semantic-router";
import { makeId } from "@/lib/utils";

const MAX_DELEGATED_STEPS_PER_BATCH = 8;
const MAX_DELEGATED_STEPS_PER_RUN = 6;
const MAX_DELEGATION_DEPTH = 2;

export type SkippedDelegation = {
  capability: string;
  reason: string;
};

export type DelegationDecision =
  | { accepted: true; role: AgentRole; capability: string; depth: number }
  | { accepted: false; capability: string; reason: string };

/** Map a free-text capability request to the most appropriate agent role. */
export async function capabilityToRole(capability: string): Promise<AgentRole | null> {
  return routeCapabilityToRole(capability);
}

export async function decideDelegation(input: {
  capability: string;
  requesterRole: AgentRole;
  parentDepth: number;
  seenCapabilities: Set<string>;
  delegatedSoFar: number;
}): Promise<DelegationDecision> {
  const capability = input.capability.trim();
  if (!capability) return { accepted: false, capability, reason: "empty capability" };
  if (input.delegatedSoFar >= MAX_DELEGATED_STEPS_PER_RUN) {
    return { accepted: false, capability, reason: `delegation budget reached (${MAX_DELEGATED_STEPS_PER_RUN})` };
  }

  const depth = input.parentDepth + 1;
  if (depth > MAX_DELEGATION_DEPTH) {
    return { accepted: false, capability, reason: `delegation depth ${depth} exceeds cap ${MAX_DELEGATION_DEPTH}` };
  }

  const key = normalizeCapability(capability);
  if (input.seenCapabilities.has(key)) {
    return { accepted: false, capability, reason: "capability already delegated in this run" };
  }

  const role = await capabilityToRole(capability);
  if (!role) {
    return { accepted: false, capability, reason: "no seat owns this capability; handled by requester instead" };
  }
  if (role === input.requesterRole) {
    return { accepted: false, capability, reason: `self-delegation to ${role} blocked` };
  }

  return { accepted: true, role, capability, depth };
}

export async function buildDelegatedStepsForWorkRequests(input: {
  runId: string;
  companyId: string;
  sourceStep: StepRecord;
  existingSteps: StepRecord[];
  requests: WorkRequest[];
  makeIdFn?: (prefix: string) => string;
}): Promise<{ steps: StepRecord[]; skipped: SkippedDelegation[] }> {
  const makeStepId = input.makeIdFn ?? makeId;
  const existingCapabilities = new Set(input.existingSteps.map((step) => delegatedCapabilityKey(step.title)));
  const batchCapabilities = new Set<string>();
  const steps: StepRecord[] = [];
  const skipped: SkippedDelegation[] = [];

  for (const request of input.requests) {
    if (steps.length >= MAX_DELEGATED_STEPS_PER_BATCH) {
      skipped.push({ capability: request.capability, reason: "delegation batch limit reached" });
      continue;
    }

    const capability = request.capability.trim();
    const key = normalizeCapability(capability);
    const targetRole = await capabilityToRole(capability);
    if (!targetRole) {
      skipped.push({ capability, reason: "unroutable capability; keeping work in the current report" });
      continue;
    }
    if (targetRole === input.sourceStep.agentRole) {
      skipped.push({ capability, reason: `same-seat delegation to ${targetRole} would create a loop` });
      continue;
    }
    if (existingCapabilities.has(key) || batchCapabilities.has(key)) {
      skipped.push({ capability, reason: "duplicate delegated capability" });
      continue;
    }

    batchCapabilities.add(key);
    steps.push({
      id: makeStepId("step"),
      title: `[delegated] ${capability}`,
      rationale: `Requested by ${input.sourceStep.agentRole} agent: ${capability}`,
      agentRole: targetRole,
      dependsOn: [input.sourceStep.id],
      expectedOutput: delegatedExpectedOutput(request),
      riskLevel: "medium",
      needsApproval: false,
      status: "pending",
    });
  }

  return { steps, skipped };
}

function delegatedExpectedOutput(request: WorkRequest): string {
  const parts = [`Handle delegated capability: ${request.capability}.`];
  if (request.input !== null && request.input !== undefined) {
    parts.push(`Input: ${JSON.stringify(request.input).slice(0, 1200)}`);
  }
  return parts.join("\n");
}

function delegatedCapabilityKey(title: string): string {
  return normalizeCapability(title.replace(/^\[delegated\]\s*/i, ""));
}

function normalizeCapability(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
