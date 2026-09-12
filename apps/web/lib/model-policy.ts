import type { Subtask } from "@/lib/planner";
import type { AgentRole } from "@/lib/types";
import { inferProviderFromModel, type ModelProvider, type ModelRouteInput, type TaskTier, type WorkbenchStreamRole } from "@/lib/model-gateway";
import { MODELS } from "@/lib/ai-client";

export type ModelQualityPolicy = "cheap" | "balanced" | "best";

export type ModelPolicyRouting = {
  preferredProvider?: ModelProvider;
  allowedProviders: ModelProvider[];
  qualityPolicy?: ModelQualityPolicy;
  region?: "us" | "eu" | "global";
};

export type ModelPolicySnapshot = {
  planner: string;
  specialist: string;
  critic: string;
  workbench: {
    planner: string;
    executor: string;
    apply: string;
    critic: string;
  };
  routing: ModelPolicyRouting;
};

const ALL_PROVIDERS: ModelProvider[] = ["anthropic", "openai", "google", "mistral", "openrouter"];

export function parseAllowedProviders(raw?: string): ModelProvider[] {
  if (!raw?.trim()) return [...ALL_PROVIDERS];
  const parsed = raw.split(",").map((part) => part.trim().toLowerCase()).filter(Boolean);
  const valid = parsed.filter((part): part is ModelProvider => ALL_PROVIDERS.includes(part as ModelProvider));
  return valid.length ? valid : [...ALL_PROVIDERS];
}

function parsePreferredProvider(raw?: string): ModelProvider | undefined {
  if (!raw?.trim()) return undefined;
  const normalized = raw.trim().toLowerCase() as ModelProvider;
  return ALL_PROVIDERS.includes(normalized) ? normalized : undefined;
}

function parseQualityPolicy(raw?: string): ModelQualityPolicy | undefined {
  if (raw === "cheap" || raw === "balanced" || raw === "best") return raw;
  return undefined;
}

function parseRegion(raw?: string): "us" | "eu" | "global" | undefined {
  if (raw === "us" || raw === "eu" || raw === "global") return raw;
  return undefined;
}

/** Authoritative model policy snapshot — env-driven, stored on orchestration runs. */
export function buildModelPolicySnapshot(): ModelPolicySnapshot {
  return {
    planner: process.env.PLANNER_MODEL
      ?? process.env.OPENAI_MODEL_STRONG
      ?? process.env.OPENAI_MODEL_DEFAULT
      ?? process.env.OPENAI_MODEL
      ?? MODELS.STRONG,
    specialist: process.env.SPECIALIST_MODEL
      ?? process.env.OPENAI_MODEL_DEFAULT
      ?? process.env.OPENAI_MODEL
      ?? MODELS.DEFAULT,
    critic: process.env.CRITIC_MODEL
      ?? process.env.OPENAI_MODEL_CRITIC
      ?? process.env.OPENAI_MODEL_STRONG
      ?? process.env.OPENAI_MODEL_DEFAULT
      ?? process.env.OPENAI_MODEL
      ?? MODELS.CRITIC,
    workbench: {
      planner: process.env.WORKBENCH_PLANNER_MODEL
        ?? process.env.PLANNER_MODEL
        ?? MODELS.PLANNER,
      executor: process.env.WORKBENCH_EXECUTOR_MODEL
        ?? process.env.OPENAI_MODEL_CODING
        ?? process.env.WORKBENCH_PLANNER_MODEL
        ?? MODELS.EXECUTOR,
      apply: process.env.WORKBENCH_APPLY_MODEL
        ?? process.env.OPENAI_MODEL_APPLY
        ?? MODELS.APPLY,
      critic: process.env.WORKBENCH_CRITIC_MODEL
        ?? process.env.CRITIC_MODEL
        ?? MODELS.CRITIC,
    },
    routing: {
      preferredProvider: parsePreferredProvider(process.env.MODEL_PREFERRED_PROVIDER),
      allowedProviders: parseAllowedProviders(process.env.MODEL_ALLOWED_PROVIDERS),
      qualityPolicy: parseQualityPolicy(process.env.MODEL_QUALITY_POLICY),
      region: parseRegion(process.env.MODEL_REGION),
    },
  };
}

function taskTierForSubtask(subtask: Subtask): TaskTier {
  if (subtask.classification.complexity === "trivial") return "triage";
  if (subtask.classification.complexity === "complex" || subtask.seat === "ceo") return "synthesis";
  return "standard";
}

function qualityPolicyForSeat(seat: AgentRole, taskTier: TaskTier): ModelQualityPolicy {
  if (seat === "ceo" || taskTier === "synthesis") return "best";
  if (taskTier === "triage") return "cheap";
  return "balanced";
}

/** Build routeModel input for workbench executor/planner streaming. */
export function buildWorkbenchRouteInput(
  role: WorkbenchStreamRole,
  policy: ModelPolicySnapshot = buildModelPolicySnapshot(),
): ModelRouteInput {
  const explicitModel = role === "executor" ? policy.workbench.executor : policy.workbench.planner;
  const inferredProvider = inferProviderFromModel(explicitModel);
  return {
    seat: "ceo",
    taskTier: role === "executor" ? "synthesis" : "standard",
    reversibility: role === "executor" ? "irreversible" : "reversible",
    preferredProvider: policy.routing.preferredProvider ?? inferredProvider,
    allowedProviders: policy.routing.allowedProviders,
    qualityPolicy: policy.routing.qualityPolicy ?? "best",
    region: policy.routing.region,
  };
}

/** Build routeModel input from policy + seat subtask classification. */
export function buildSeatRouteInput(
  subtask: Subtask,
  policy: ModelPolicySnapshot = buildModelPolicySnapshot(),
): ModelRouteInput {
  const taskTier = taskTierForSubtask(subtask);
  return {
    seat: subtask.seat,
    taskTier,
    reversibility: subtask.classification.reversibility,
    preferredProvider: policy.routing.preferredProvider,
    allowedProviders: policy.routing.allowedProviders,
    qualityPolicy: policy.routing.qualityPolicy ?? qualityPolicyForSeat(subtask.seat, taskTier),
    region: policy.routing.region,
  };
}
