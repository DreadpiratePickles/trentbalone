import OpenAI from "openai";
import type { WorkbenchSession } from "@/lib/types";
import { getWorkbenchProvider } from "@/lib/workbench-provider";
import {
  streamAnthropicMessages,
  streamOpenAiCompatibleChat,
  type ProviderStreamToken,
} from "@/lib/ai-client";
import {
  routeWorkbenchStream,
  type ModelProvider,
  type WorkbenchStreamRole,
} from "@/lib/model-gateway";
import type { ModelPolicySnapshot } from "@/lib/model-policy";
import { buildModelPolicySnapshot } from "@/lib/model-policy";
import {
  type AgentDeps,
  type ArtifactStreamToken,
  type StreamInput,
} from "@/lib/workbench-agent-types";

export type WorkbenchStreamProviderFn = (
  provider: ModelProvider,
  model: string,
  input: StreamInput,
  maxTokens: number,
) => AsyncGenerator<ArtifactStreamToken>;

export type WorkbenchStreamOverrides = {
  streamProvider?: WorkbenchStreamProviderFn;
  policy?: ModelPolicySnapshot;
};

let streamOverrides: WorkbenchStreamOverrides | undefined;

/** Test hook: inject per-provider stream behavior without real API keys. */
export function setWorkbenchStreamOverrides(overrides: WorkbenchStreamOverrides | undefined) {
  streamOverrides = overrides;
}

function makeClient(): OpenAI {
  return new OpenAI({
    apiKey:  process.env.OPENAI_API_KEY,
    baseURL: process.env.OPENAI_BASE_URL || undefined,
    timeout: 120_000,
  });
}

export function usesResponsesApi(model: string): boolean {
  const normalized = model.toLowerCase();
  return normalized.includes("codex") || normalized.startsWith("gpt-5");
}

export async function* streamResponsesText(
  messages: StreamInput["messages"],
  model: string,
  maxTokens: number,
): AsyncGenerator<ArtifactStreamToken> {
  const stream = await makeClient().responses.create({
    model,
    input: messages.map((message) => ({
      type: "message" as const,
      role: message.role,
      content: message.content,
    })),
    max_output_tokens: maxTokens,
    stream: true,
  });
  for await (const event of stream) {
    const typed = event as {
      type?: string;
      delta?: string;
      response?: { usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number } };
    };
    if (typed.type === "response.output_text.delta" && typed.delta) {
      yield { type: "token", content: typed.delta };
    } else if (typed.type === "response.completed") {
      const usage = typed.response?.usage;
      if (usage) {
        yield {
          type: "usage",
          inputTokens: usage.input_tokens ?? 0,
          outputTokens: usage.output_tokens ?? 0,
        };
      }
      yield { type: "finish", reason: "stop" };
    } else if (typed.type === "response.incomplete") {
      yield { type: "finish", reason: "length" };
    } else if (typed.type === "response.failed") {
      yield { type: "finish", reason: "error" };
    }
  }
}

function mapProviderToken(token: ProviderStreamToken): ArtifactStreamToken {
  if (token.type === "token") return { type: "token", content: token.content };
  if (token.type === "usage") {
    return { type: "usage", inputTokens: token.inputTokens, outputTokens: token.outputTokens };
  }
  return { type: "finish", reason: token.reason };
}

export async function* streamProviderArtifact(
  provider: ModelProvider,
  model: string,
  input: StreamInput,
  maxTokens: number,
): AsyncGenerator<ArtifactStreamToken> {
  const messages = input.messages;
  const temperature = 0.2;

  if (provider === "anthropic") {
    for await (const token of streamAnthropicMessages({ model, messages, temperature, maxTokens })) {
      yield mapProviderToken(token);
    }
    return;
  }

  if (provider === "openai" && usesResponsesApi(model)) {
    yield* streamResponsesText(messages, model, maxTokens);
    return;
  }

  for await (const token of streamOpenAiCompatibleChat(provider, { model, messages, temperature, maxTokens })) {
    yield mapProviderToken(token);
  }
}

function providersForRoute(
  route: ReturnType<typeof routeWorkbenchStream>,
  useFullChain: boolean,
): ModelProvider[] {
  return useFullChain ? route.fallbackChain : route.providers;
}

export async function* streamArtifactWithFallback(
  input: StreamInput,
  options?: {
    role?: WorkbenchStreamRole;
    policy?: ModelPolicySnapshot;
    streamProvider?: WorkbenchStreamProviderFn;
  },
): AsyncGenerator<ArtifactStreamToken> {
  const role = options?.role ?? "executor";
  const policy = options?.policy ?? streamOverrides?.policy ?? buildModelPolicySnapshot();
  const route = routeWorkbenchStream(role, policy);
  const injected = options?.streamProvider ?? streamOverrides?.streamProvider;
  const streamFn = injected ?? streamProviderArtifact;
  const providers = providersForRoute(route, Boolean(injected));
  const maxTokens = role === "executor" ? 32768 : 8192;

  if (providers.length === 0) {
    yield { type: "finish", reason: "error" };
    return;
  }

  let lastError: string | undefined;
  for (let index = 0; index < providers.length; index++) {
    const provider = providers[index]!;
    const model = route.modelForProvider(provider);
    try {
      for await (const token of streamFn(provider, model, input, maxTokens)) {
        yield token;
      }
      return;
    } catch (error) {
      lastError = error instanceof Error ? error.message : "stream failed";
      console.error(`streamArtifact(${role}/${provider}): failed`, lastError);
    }
  }

  console.error(`streamArtifact(${role}): exhausted fallback chain`, lastError);
  yield { type: "finish", reason: "error" };
}

export async function* defaultStreamArtifact(input: StreamInput): AsyncGenerator<ArtifactStreamToken> {
  yield* streamArtifactWithFallback(input, { role: "executor" });
}

export async function* defaultStream(input: { system: string; user: string }): AsyncGenerator<string> {
  const policy = streamOverrides?.policy ?? buildModelPolicySnapshot();
  const route = routeWorkbenchStream("planner", policy);
  const injected = streamOverrides?.streamProvider;
  const streamFn = injected ?? streamProviderArtifact;
  const providers = providersForRoute(route, Boolean(injected));
  const maxTokens = 8192;

  if (providers.length === 0) {
    yield "Model not configured.";
    return;
  }

  const messages: StreamInput["messages"] = [
    { role: "system", content: input.system },
    { role: "user", content: input.user },
  ];

  let lastError: string | undefined;
  for (let index = 0; index < providers.length; index++) {
    const provider = providers[index]!;
    const model = route.modelForProvider(provider);
    try {
      for await (const token of streamFn(provider, model, { messages }, maxTokens)) {
        if (token.type === "token") yield token.content;
      }
      return;
    } catch (error) {
      lastError = error instanceof Error ? error.message : "stream failed";
      console.error(`defaultStream(planner/${provider}): failed`, lastError);
    }
  }

  yield "Model not configured.";
}

export function resolveDeps(session: WorkbenchSession, overrides?: Partial<AgentDeps>): AgentDeps {
  return {
    streamArtifact: overrides?.streamArtifact ?? defaultStreamArtifact,
    stream:         overrides?.stream         ?? defaultStream,
    provider:       overrides?.provider       ?? getWorkbenchProvider(session.provider),
    acceptanceSteps: overrides?.acceptanceSteps,
    interactionDriver: overrides?.interactionDriver,
    criticReviewer: overrides?.criticReviewer,
  };
}

/** Collect stream tokens and report whether a fallback provider was used. */
export async function collectStreamArtifactWithMeta(
  input: StreamInput,
  options?: Parameters<typeof streamArtifactWithFallback>[1],
): Promise<{ tokens: ArtifactStreamToken[]; fallback: boolean }> {
  const role = options?.role ?? "executor";
  const policy = options?.policy ?? buildModelPolicySnapshot();
  const route = routeWorkbenchStream(role, policy);
  const providersTried: ModelProvider[] = [];
  const streamFn = options?.streamProvider ?? streamProviderArtifact;

  const wrappedProvider: WorkbenchStreamProviderFn = async function* (provider, model, streamInput, maxTokens) {
    providersTried.push(provider);
    yield* streamFn(provider, model, streamInput, maxTokens);
  };

  const tokens: ArtifactStreamToken[] = [];
  for await (const token of streamArtifactWithFallback(input, { ...options, streamProvider: wrappedProvider })) {
    tokens.push(token);
  }

  return { tokens, fallback: providersTried.length > 1 };
}
