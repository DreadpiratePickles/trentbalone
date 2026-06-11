/**
 * lib/ai-client.ts — Shared AI client factory, model constants, and wrappers.
 *
 * Single source of truth for:
 *   - Valid model names (guards against silent failures from bad strings)
 *   - max_tokens defaults (prevents truncation + silent JSON fallbacks)
 *   - callJson / callText wrappers with proper error propagation
 *   - Model tier → name resolution (haiku / sonnet / opus → real GPT-4 family)
 *
 * All agent, orchestrator, and cycle code imports from here.
 * The generation/ stack (text-router, image-router, etc.) has its own
 * well-designed provider chain and does not need this.
 */

import OpenAI from "openai";
import { z } from "zod";
import type { ModelProvider, ModelTier } from "@/lib/model-gateway";

// ── Model name registry ───────────────────────────────────────────────────────
// Single place to update when OpenAI releases new models.

export const MODELS = {
  /** Fast + cheap: triage tasks, support triage, low-risk summaries. */
  FAST:    process.env.OPENAI_MODEL_FAST    ?? "gpt-4.1-nano",
  /** Default: agent execution, CEO chat, operating plans. */
  DEFAULT: process.env.OPENAI_MODEL_DEFAULT ?? process.env.OPENAI_MODEL ?? "gpt-4.1-mini",
  /** Strong: orchestration planning, critique, irreversible-action reasoning. */
  STRONG:  process.env.OPENAI_MODEL_STRONG  ?? "gpt-5.2",
  /** Coding: autonomous Workbench build/repair loops (legacy alias). */
  CODING:  process.env.OPENAI_MODEL_CODING  ?? process.env.WORKBENCH_PLANNER_MODEL ?? "gpt-5.2-codex",
  /** Critic: verification review and safety review. */
  CRITIC:  process.env.OPENAI_MODEL_CRITIC  ?? process.env.OPENAI_MODEL_STRONG ?? "gpt-5.2",
  /** Workbench planner: strong reasoning for structured plans. */
  PLANNER: process.env.WORKBENCH_PLANNER_MODEL
    ?? process.env.PLANNER_MODEL
    ?? process.env.OPENAI_MODEL_STRONG
    ?? "gpt-5.2",
  /** Workbench executor: top coding model for artifact generation (A/B via env). */
  EXECUTOR: process.env.WORKBENCH_EXECUTOR_MODEL
    ?? process.env.OPENAI_MODEL_CODING
    ?? process.env.WORKBENCH_PLANNER_MODEL
    ?? "gpt-5.2-codex",
  /** Workbench apply: cheap/fast merge model for edit blocks. */
  APPLY:   process.env.WORKBENCH_APPLY_MODEL
    ?? process.env.OPENAI_MODEL_APPLY
    ?? process.env.OPENAI_MODEL_FAST
    ?? "gpt-4.1-nano",
  /** Anthropic tier defaults for multi-provider routing. */
  ANTHROPIC_FAST:    process.env.ANTHROPIC_MODEL_FAST    ?? "claude-haiku-4-5-20251001",
  ANTHROPIC_DEFAULT: process.env.ANTHROPIC_MODEL_DEFAULT ?? "claude-sonnet-4-6",
  ANTHROPIC_STRONG:  process.env.ANTHROPIC_MODEL_STRONG  ?? "claude-opus-4-8",
} as const;

/** Map ModelTier (haiku/sonnet/opus) to a provider-specific model name. */
export function resolveModelName(tier: ModelTier, provider: ModelProvider = "openai"): string {
  switch (provider) {
    case "anthropic":
      if (tier === "haiku") return MODELS.ANTHROPIC_FAST;
      if (tier === "opus") return MODELS.ANTHROPIC_STRONG;
      return MODELS.ANTHROPIC_DEFAULT;
    case "openrouter": {
      const base = resolveModelName(tier, "anthropic");
      return `anthropic/${base}`;
    }
    case "mistral":
      if (tier === "haiku") return process.env.MISTRAL_MODEL_FAST ?? "mistral-small-latest";
      if (tier === "opus") return process.env.MISTRAL_MODEL_STRONG ?? "mistral-large-latest";
      return process.env.MISTRAL_MODEL_DEFAULT ?? "mistral-medium-latest";
    case "google":
      if (tier === "haiku") return process.env.GOOGLE_MODEL_FAST ?? "gemini-2.0-flash";
      if (tier === "opus") return process.env.GOOGLE_MODEL_STRONG ?? "gemini-2.5-pro";
      return process.env.GOOGLE_MODEL_DEFAULT ?? "gemini-2.0-flash";
    default:
      if (tier === "haiku") return MODELS.FAST;
      if (tier === "opus") return MODELS.STRONG;
      return MODELS.DEFAULT;
  }
}

export function isProviderConfigured(provider: ModelProvider): boolean {
  switch (provider) {
    case "openai": return Boolean(process.env.OPENAI_API_KEY);
    case "anthropic": return Boolean(process.env.ANTHROPIC_API_KEY);
    case "google": return Boolean(process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY);
    case "mistral": return Boolean(process.env.MISTRAL_API_KEY);
    case "openrouter": return Boolean(process.env.OPENROUTER_API_KEY);
  }
}

// ── max_tokens defaults ───────────────────────────────────────────────────────

export const MAX_TOKENS = {
  /** Short structured outputs: JSON plans, critiques. */
  JSON:     8192,
  /** Medium prose: agent execution summaries, briefings. */
  PROSE:    4096,
  /** Long streaming/chat: CEO chat, research. */
  CHAT:     8192,
  /** Orchestration planning: needs room for multi-step DAGs. */
  PLANNING: 8192,
} as const;

// ── Client factory ────────────────────────────────────────────────────────────

export function createAIClient(): OpenAI {
  return new OpenAI({
    apiKey:  process.env.OPENAI_API_KEY,
    baseURL: process.env.OPENAI_BASE_URL || undefined,
    timeout: 60_000,
  });
}

type ProviderChatInput = {
  model: string;
  temperature: number;
  response_format: { type: "json_object" };
  messages: Array<{ role: "system" | "user"; content: string }>;
};

type ProviderChatOutput = {
  choices: Array<{ message: { content: string | null } }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
};

/** OpenAI-compatible chat completion for a routed provider. */
export async function createProviderChatCompletion(
  provider: ModelProvider,
  input: ProviderChatInput,
): Promise<ProviderChatOutput> {
  if (provider === "anthropic") return anthropicChatCompletion(input);
  const client = openAiCompatibleClient(provider);
  return client.chat.completions.create({
    ...input,
    max_tokens: MAX_TOKENS.JSON,
  }) as Promise<ProviderChatOutput>;
}

function openAiCompatibleClient(provider: Exclude<ModelProvider, "anthropic">): OpenAI {
  if (provider === "openai") return createAIClient();
  const configs: Record<Exclude<ModelProvider, "anthropic" | "openai">, { apiKey?: string; baseURL: string }> = {
    openrouter: {
      apiKey: process.env.OPENROUTER_API_KEY,
      baseURL: process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1",
    },
    mistral: {
      apiKey: process.env.MISTRAL_API_KEY,
      baseURL: process.env.MISTRAL_BASE_URL ?? "https://api.mistral.ai/v1",
    },
    google: {
      apiKey: process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY,
      baseURL: process.env.GOOGLE_BASE_URL ?? "https://generativelanguage.googleapis.com/v1beta/openai/",
    },
  };
  const config = configs[provider];
  return new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseURL,
    timeout: 60_000,
  });
}

async function anthropicChatCompletion(input: ProviderChatInput): Promise<ProviderChatOutput> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not configured");

  const system = input.messages.find((message) => message.role === "system")?.content ?? "";
  const user = input.messages.filter((message) => message.role === "user").map((message) => message.content).join("\n");
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: input.model,
      max_tokens: MAX_TOKENS.JSON,
      temperature: input.temperature,
      system: `${system}\nRespond with valid JSON only.`,
      messages: [{ role: "user", content: user }],
    }),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => response.statusText);
    throw new Error(`anthropic request failed: ${response.status} ${detail.slice(0, 200)}`);
  }
  const payload = await response.json() as {
    content?: Array<{ type?: string; text?: string }>;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  const content = payload.content?.find((block) => block.type === "text")?.text ?? null;
  const promptTokens = payload.usage?.input_tokens ?? 0;
  const completionTokens = payload.usage?.output_tokens ?? 0;
  return {
    choices: [{ message: { content } }],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  };
}

/**
 * Strip Markdown code fences / preamble from an LLM JSON response.
 * Anthropic models (Claude) routed through OpenAI-compatible bridges frequently
 * wrap `response_format: json_object` output in ```json … ``` fences and may add
 * a short preamble before it. This returns the inner JSON payload by, in order:
 *   1. returning the string as-is if it already parses,
 *   2. extracting the contents of the first ``` fenced block,
 *   3. extracting the first balanced `{ … }` / `[ … ]` block.
 * OpenAI native responses pass through untouched.
 */
export function stripJsonFences(content: string): string {
  const trimmed = content.trim();
  if (!trimmed) return trimmed;

  // 1. Already valid JSON?
  try {
    JSON.parse(trimmed);
    return trimmed;
  } catch {
    /* continue */
  }

  // 2. A ``` fenced block anywhere in the content.
  const fence = trimmed.match(/```(?:json|JSON)?\s*\n?([\s\S]*?)```/);
  if (fence?.[1]) {
    const inner = fence[1].trim();
    try {
      JSON.parse(inner);
      return inner;
    } catch {
      /* continue */
    }
  }

  // 3. First balanced object/array substring (handles a prose preamble).
  const firstObj = trimmed.indexOf("{");
  const firstArr = trimmed.indexOf("[");
  const start = firstArr === -1 ? firstObj : firstObj === -1 ? firstArr : Math.min(firstObj, firstArr);
  if (start !== -1) {
    const open = trimmed[start];
    const close = open === "{" ? "}" : "]";
    const end = trimmed.lastIndexOf(close);
    if (end > start) {
      const candidate = trimmed.slice(start, end + 1);
      try {
        JSON.parse(candidate);
        return candidate;
      } catch {
        /* continue */
      }
    }
  }

  return trimmed;
}

// ── callJson — structured JSON completion with Zod validation ─────────────────

export type CallJsonOptions = {
  /** Injected in tests to avoid real API calls. */
  createCompletion?: (
    model: string,
    messages: OpenAI.Chat.ChatCompletionMessageParam[],
    maxTokens: number,
  ) => Promise<{ content: string | null; totalTokens: number }>;
};

/**
 * Call an OpenAI model expecting a JSON object response.
 * Returns the parsed result or throws — never silently falls back.
 * Callers decide whether to catch and substitute a deterministic fallback.
 */
export async function callJson<T>(
  model: string,
  system: string,
  user: string,
  schema: z.ZodTypeAny,
  maxTokens: number = MAX_TOKENS.JSON,
  opts?: CallJsonOptions,
): Promise<{ data: T; tokens: number }> {
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: system },
    { role: "user",   content: user },
  ];

  let content: string | null;
  let totalTokens: number;

  if (opts?.createCompletion) {
    ({ content, totalTokens } = await opts.createCompletion(model, messages, maxTokens));
  } else {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error("OPENAI_API_KEY is not configured");
    }
    const completion = await createAIClient().chat.completions.create({
      model,
      temperature:     0.2,
      max_tokens:      maxTokens,
      response_format: { type: "json_object" },
      messages,
    });
    content     = completion.choices[0]?.message.content ?? null;
    totalTokens = completion.usage?.total_tokens ?? 0;
  }

  if (!content) throw new Error(`${model} returned empty content`);

  let raw: unknown;
  try {
    raw = JSON.parse(stripJsonFences(content));
  } catch {
    throw new Error(`${model} returned non-JSON: ${content.slice(0, 200)}`);
  }

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `${model} response failed schema validation: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
    );
  }

  return { data: parsed.data as T, tokens: totalTokens };
}

// ── callText — plain-text chat completion ─────────────────────────────────────

/**
 * Call an OpenAI model expecting plain text (no structured output).
 * Returns text + token count or throws — never silently falls back.
 */
export async function callText(
  model: string,
  system: string,
  user: string,
  maxTokens = MAX_TOKENS.PROSE,
): Promise<{ text: string; tokens: number }> {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is not configured");
  }
  const completion = await createAIClient().chat.completions.create({
    model,
    temperature: 0.4,
    max_tokens:  maxTokens,
    messages: [
      { role: "system", content: system },
      { role: "user",   content: user },
    ],
  });
  const text = completion.choices[0]?.message.content?.trim();
  if (!text) throw new Error(`${model} returned empty text`);
  return { text, tokens: completion.usage?.total_tokens ?? 0 };
}

// ── Provider streaming ────────────────────────────────────────────────────────

export type StreamMessage = { role: "system" | "user" | "assistant"; content: string };

export type ProviderStreamToken =
  | { type: "token"; content: string }
  | { type: "finish"; reason: "stop" | "length" | "error" | string }
  | { type: "usage"; inputTokens: number; outputTokens: number };

type ProviderStreamInput = {
  model: string;
  messages: StreamMessage[];
  temperature: number;
  maxTokens: number;
};

/** Stream chat completions for OpenAI-compatible providers (not Anthropic native). */
export async function* streamOpenAiCompatibleChat(
  provider: Exclude<ModelProvider, "anthropic">,
  input: ProviderStreamInput,
): AsyncGenerator<ProviderStreamToken> {
  const client = openAiCompatibleClient(provider);
  const stream = await client.chat.completions.create({
    model: input.model,
    temperature: input.temperature,
    max_tokens: input.maxTokens,
    stream: true,
    stream_options: provider === "openai" ? { include_usage: true } : undefined,
    messages: input.messages as OpenAI.Chat.ChatCompletionMessageParam[],
  });

  for await (const chunk of stream) {
    const token = chunk.choices[0]?.delta?.content;
    if (token) yield { type: "token", content: token };
    const reason = chunk.choices[0]?.finish_reason;
    if (reason) {
      yield { type: "finish", reason: reason === "length" ? "length" : reason === "stop" ? "stop" : reason };
    }
    if (chunk.usage) {
      yield {
        type: "usage",
        inputTokens: chunk.usage.prompt_tokens ?? 0,
        outputTokens: chunk.usage.completion_tokens ?? 0,
      };
    }
  }
}

/** Stream via Anthropic Messages API (native SSE). */
export async function* streamAnthropicMessages(input: ProviderStreamInput): AsyncGenerator<ProviderStreamToken> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not configured");

  const system = input.messages.filter((message) => message.role === "system").map((message) => message.content).join("\n");
  const chatMessages = input.messages
    .filter((message) => message.role !== "system")
    .map((message) => ({
      role: message.role === "assistant" ? "assistant" as const : "user" as const,
      content: message.content,
    }));

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: input.model,
      max_tokens: input.maxTokens,
      temperature: input.temperature,
      system: system || undefined,
      messages: chatMessages,
      stream: true,
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => response.statusText);
    throw new Error(`anthropic stream failed: ${response.status} ${detail.slice(0, 200)}`);
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error("anthropic stream: no response body");

  const decoder = new TextDecoder();
  let buffer = "";
  let inputTokens = 0;
  let outputTokens = 0;
  let finishReason: ProviderStreamToken | null = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6).trim();
      if (!data || data === "[DONE]") continue;

      let event: {
        type?: string;
        delta?: { type?: string; text?: string; stop_reason?: string };
        message?: { usage?: { input_tokens?: number } };
        usage?: { output_tokens?: number };
      };
      try {
        event = JSON.parse(data) as typeof event;
      } catch {
        continue;
      }

      if (event.type === "message_start" && event.message?.usage) {
        inputTokens = event.message.usage.input_tokens ?? 0;
      } else if (event.type === "content_block_delta" && event.delta?.type === "text_delta" && event.delta.text) {
        yield { type: "token", content: event.delta.text };
      } else if (event.type === "message_delta") {
        if (event.usage?.output_tokens) outputTokens = event.usage.output_tokens;
        if (event.delta?.stop_reason) {
          finishReason = {
            type: "finish",
            reason: event.delta.stop_reason === "max_tokens" ? "length" : "stop",
          };
        }
      }
    }
  }

  if (finishReason) yield finishReason;
  yield { type: "usage", inputTokens, outputTokens };
}

// ── estimateCostCents ─────────────────────────────────────────────────────────

/** Rough cost estimate for token-count metering in agent loops. */
export function estimateCostCents(
  inputTokens: number,
  outputTokens: number,
  tier: ModelTier = "sonnet",
): number {
  const rates: Record<ModelTier, { input: number; output: number }> = {
    haiku:  { input: 0.015, output: 0.06  },
    sonnet: { input: 0.15,  output: 0.6   },
    opus:   { input: 0.5,   output: 1.5   },
  };
  const r = rates[tier];
  return Math.max(1, Math.ceil((inputTokens / 1000) * r.input + (outputTokens / 1000) * r.output));
}
