import { createHash } from "node:crypto";
import OpenAI from "openai";
import type { AgentRole, ToolCallRecord } from "@/lib/types";
import type { Subtask } from "@/lib/planner";
import {
  createProviderChatCompletion,
  isProviderConfigured,
  resolveModelName,
} from "@/lib/ai-client";
import {
  buildModelPolicySnapshot,
  buildSeatRouteInput,
  buildWorkbenchRouteInput,
  type ModelPolicySnapshot,
} from "@/lib/model-policy";

export type ModelProvider = "anthropic" | "openai" | "google" | "mistral" | "openrouter";
export type WorkbenchStreamRole = "executor" | "planner";
export type ModelTier = "haiku" | "sonnet" | "opus";
export type TaskTier = "triage" | "standard" | "synthesis";
export type Reversibility = "reversible" | "costly" | "irreversible";

export type ModelRouteInput = {
  seat: AgentRole;
  taskTier: TaskTier;
  reversibility: Reversibility;
  preferredProvider?: ModelProvider;
  qualityPolicy?: "cheap" | "balanced" | "best";
  region?: "us" | "eu" | "global";
  latencyBudgetMs?: number;
  allowedProviders?: ModelProvider[];
};

export type ModelRoute = {
  provider: ModelProvider;
  modelTier: ModelTier;
  fallbackChain: ModelProvider[];
  reason: string;
};

type ChatCompletionInput = {
  model: string;
  temperature: number;
  response_format: { type: "json_object" };
  messages: Array<{ role: "system" | "user"; content: string }>;
};

type ChatCompletionOutput = {
  choices: Array<{ message: { content: string | null } }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
};

export type SeatModelExecutionResult = {
  output: unknown;
  model: string;
  tokens: number;
  costCents: number;
  fallback: boolean;
  error?: string;
};

export type ToolLoopTurn = {
  adapter: string;
  action: string;
  result: ToolCallRecord;
};

export type ToolLoopContext = {
  step: number;
  maxSteps: number;
  toolHistory: ToolLoopTurn[];
  availableTools: string[];
};

export type SeatModelExecutionInput = {
  companyId: string;
  subtask: Subtask;
  systemPrompt: string;
  dynamicPrompt?: string;
  toolLoopContext?: ToolLoopContext;
  modelPolicy?: ModelPolicySnapshot;
  createChatCompletion?: (input: ChatCompletionInput) => Promise<ChatCompletionOutput>;
};

const semanticResultCache = new Map<string, SeatModelExecutionResult>();

export function clearModelGatewayCache() {
  semanticResultCache.clear();
}

const tierCostsPer1k: Record<ModelTier, { input: number; output: number }> = {
  haiku: { input: 0.025, output: 0.125 },
  sonnet: { input: 0.3, output: 1.5 },
  opus: { input: 1.5, output: 7.5 },
};

export function routeModel(input: ModelRouteInput): ModelRoute {
  const provider = chooseProvider(input);
  let modelTier: ModelTier = input.taskTier === "triage" ? "haiku" : input.taskTier === "synthesis" ? "opus" : "sonnet";
  if (input.reversibility === "irreversible" || input.seat === "finance" || input.seat === "ceo") modelTier = "opus";
  if (input.seat === "support" && input.reversibility === "reversible" && input.taskTier === "triage") modelTier = "haiku";
  return {
    provider,
    modelTier,
    fallbackChain: input.allowedProviders?.length
      ? [provider, ...input.allowedProviders.filter((p) => p !== provider)]
      : buildFallbackChain(provider),
    reason: `${input.seat}:${input.taskTier}:${input.reversibility}`,
  };
}

export function buildFallbackChain(primary: ModelProvider): ModelProvider[] {
  return [primary, ...(["anthropic", "openai", "google", "mistral", "openrouter"] as ModelProvider[]).filter((p) => p !== primary)];
}

export function inferProviderFromModel(model: string): ModelProvider | undefined {
  const normalized = model.toLowerCase();
  if (normalized.includes("claude")) {
    return normalized.startsWith("anthropic/") ? "openrouter" : "anthropic";
  }
  if (normalized.includes("gemini")) return "google";
  if (normalized.includes("mistral")) return "mistral";
  if (normalized.includes("gpt") || normalized.includes("codex") || /^o[13]/.test(normalized)) return "openai";
  return undefined;
}

export type WorkbenchStreamRoute = {
  providers: ModelProvider[];
  fallbackChain: ModelProvider[];
  modelTier: ModelTier;
  explicitModel: string;
  reason: string;
  modelForProvider: (provider: ModelProvider) => string;
};

export function routeWorkbenchStream(
  role: WorkbenchStreamRole,
  policy: ModelPolicySnapshot = buildModelPolicySnapshot(),
): WorkbenchStreamRoute {
  const route = routeModel(buildWorkbenchRouteInput(role, policy));
  const explicitModel = role === "executor" ? policy.workbench.executor : policy.workbench.planner;
  const explicitProvider = inferProviderFromModel(explicitModel);
  const providers = route.fallbackChain.filter((provider) => isProviderConfigured(provider));

  return {
    providers,
    fallbackChain: route.fallbackChain,
    modelTier: route.modelTier,
    explicitModel,
    reason: route.reason,
    modelForProvider: (provider) => resolveWorkbenchModelName({
      provider,
      explicitModel,
      explicitProvider,
      modelTier: route.modelTier,
    }),
  };
}

function resolveWorkbenchModelName(input: {
  provider: ModelProvider;
  explicitModel: string;
  explicitProvider?: ModelProvider;
  modelTier: ModelTier;
}): string {
  if (input.explicitProvider === input.provider) return input.explicitModel;
  if (
    input.provider === "openrouter"
    && input.explicitProvider === "anthropic"
    && !input.explicitModel.includes("/")
  ) {
    return `anthropic/${input.explicitModel}`;
  }
  return resolveModelName(input.modelTier, input.provider);
}

function chooseProvider(input: ModelRouteInput): ModelProvider {
  const allowed = input.allowedProviders?.length ? input.allowedProviders : ["anthropic", "openai", "google", "mistral", "openrouter"] as ModelProvider[];
  const preferred = input.preferredProvider && allowed.includes(input.preferredProvider) ? input.preferredProvider : null;
  if (preferred) return preferred;
  if (input.latencyBudgetMs && input.latencyBudgetMs <= 500 && allowed.includes("openai")) return "openai";
  if (input.region === "eu" && allowed.includes("mistral")) return "mistral";
  if (input.qualityPolicy === "cheap" && allowed.includes("openrouter")) return "openrouter";
  if (input.qualityPolicy === "best" && allowed.includes("anthropic")) return "anthropic";
  return allowed[0] ?? "anthropic";
}

export function estimateModelCostCents(input: { modelTier: ModelTier; inputTokens: number; outputTokens: number }) {
  const cost = tierCostsPer1k[input.modelTier];
  return Math.ceil((input.inputTokens / 1000) * cost.input + (input.outputTokens / 1000) * cost.output);
}

export function semanticCacheKey(input: { companyId: string; taskType: string; prompt: string }) {
  const normalized = `${input.companyId}:${input.taskType}:${input.prompt.trim().toLowerCase()}`;
  return `semcache_${createHash("sha256").update(normalized).digest("hex").slice(0, 24)}`;
}

export async function executeSeatModel(input: SeatModelExecutionInput): Promise<SeatModelExecutionResult> {
  const policy = input.modelPolicy ?? buildModelPolicySnapshot();
  const route = routeModel(buildSeatRouteInput(input.subtask, policy));
  const configuredChain = route.fallbackChain.filter((provider) => (
    input.createChatCompletion ? true : isProviderConfigured(provider)
  ));

  if (!input.createChatCompletion && configuredChain.length === 0) {
    const message = "No model provider API keys are configured for the allowed provider chain";
    return {
      output: { error: message },
      model: "not-configured",
      tokens: 0,
      costCents: 0,
      fallback: true,
      error: message,
    };
  }

  const cacheKey = cacheKeyForSeatModel(input);
  if (cacheKey) {
    const cached = semanticResultCache.get(cacheKey);
    if (cached) return cached;
  }

  const messages: ChatCompletionInput["messages"] = [
    { role: "system", content: input.systemPrompt },
    { role: "user", content: buildSeatUserPrompt(input) },
  ];
  const requestBase: Omit<ChatCompletionInput, "model"> = {
    temperature: 0.2,
    response_format: { type: "json_object" },
    messages,
  };

  let lastError: string | undefined;
  const providersToTry = input.createChatCompletion
    ? route.fallbackChain
    : configuredChain;

  for (let index = 0; index < providersToTry.length; index++) {
    const provider = providersToTry[index];
    const resolvedModel = resolveModelName(route.modelTier, provider);
    try {
      const completion = input.createChatCompletion
        ? await input.createChatCompletion({ ...requestBase, model: resolvedModel })
        : await createProviderChatCompletion(provider, { ...requestBase, model: resolvedModel });
      const promptTokens = completion.usage?.prompt_tokens ?? 0;
      const completionTokens = completion.usage?.completion_tokens ?? 0;
      const tokens = completion.usage?.total_tokens ?? promptTokens + completionTokens;
      const result = {
        output: parseModelContent(completion.choices[0]?.message.content ?? "{}"),
        model: resolvedModel,
        tokens,
        costCents: estimateModelCostCents({
          modelTier: route.modelTier,
          inputTokens: promptTokens,
          outputTokens: completionTokens,
        }),
        fallback: index > 0,
      };
      if (cacheKey) semanticResultCache.set(cacheKey, result);
      return result;
    } catch (error) {
      lastError = error instanceof Error ? error.message : "model execution failed";
      console.error(`executeSeatModel(${input.subtask.seat}/${provider}): failed`, lastError);
    }
  }

  return {
    output: { error: lastError ?? "model execution failed" },
    model: resolveModelName(route.modelTier, providersToTry[0] ?? route.provider),
    tokens: 0,
    costCents: 0,
    fallback: true,
    error: lastError ?? "model execution failed",
  };
}

function cacheKeyForSeatModel(input: SeatModelExecutionInput) {
  const readOnlySeat = input.subtask.seat === "analyst";
  if (!readOnlySeat || input.subtask.classification.reversibility !== "reversible") return null;
  return semanticCacheKey({
    companyId: input.companyId,
    taskType: input.subtask.seat,
    prompt: [
      input.subtask.objective,
      JSON.stringify(input.subtask.input ?? {}),
      JSON.stringify(input.subtask.contextBundle),
    ].join("\n"),
  });
}

function buildSeatUserPrompt(input: SeatModelExecutionInput) {
  const ctx = input.subtask.contextBundle as Record<string, unknown>;
  const companyName = (ctx.company as { name?: string } | undefined)?.name ?? input.companyId;
  const lines = [
    `Company: ${companyName} (id: ${input.companyId})`,
    `Seat: ${input.subtask.seat}`,
    `Objective: ${input.subtask.objective}`,
    `Boundaries: ${input.subtask.boundaries.join("; ") || "none"}`,
    `Tool guidance: ${input.subtask.toolGuidance.join("; ") || "none"}`,
    `Context: ${JSON.stringify(input.subtask.contextBundle)}`,
    `Input: ${JSON.stringify(input.subtask.input ?? {})}`,
    input.dynamicPrompt ?? "",
  ];

  const loop = input.toolLoopContext;
  if (loop) {
    lines.push(
      `Available tools: ${loop.availableTools.join(", ") || "none"}`,
      `Tool-use step ${loop.step} of ${loop.maxSteps}.`,
    );
    if (loop.toolHistory.length > 0) {
      lines.push(
        "Prior tool results (use these in your answer):",
        ...loop.toolHistory.map((turn) => (
          `- ${turn.adapter}("${turn.action}"): [${turn.result.status}] ${turn.result.summary}`
        )),
      );
    }
    lines.push(
      "Respond as JSON. Either call a tool OR finish:",
      '{ "toolCall": { "name": string, "action": string }, "summary": null } — to invoke a tool,',
      'OR { "toolCall": null, "summary": string, "findings": [], "recommendations": [], "workRequests": [] } — when done.',
      "workRequests format: [{capability: string, input: object|null}] — use to delegate to another agent.",
    );
  } else {
    lines.push(
      "Respond as JSON with keys: summary, findings, recommendations, workRequests.",
      "workRequests format: [{capability: string, input: object|null}] — use to delegate to another agent.",
    );
  }

  return lines.filter(Boolean).join("\n");
}

function parseModelContent(content: string) {
  try {
    return JSON.parse(content) as unknown;
  } catch {
    return { text: content };
  }
}
