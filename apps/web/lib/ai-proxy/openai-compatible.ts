import { createHash } from "node:crypto";
import { estimateModelCostCents, routeModel, type ModelRoute } from "@/lib/model-gateway";
import { makeId } from "@/lib/utils";

export type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
};

export type NormalizedChatRequest = {
  model: string;
  messages: ChatMessage[];
  prompt: string;
  temperature: number;
  maxTokens: number;
};

export class StreamingNotSupportedError extends Error {
  constructor() {
    super("streaming_not_supported_yet");
    this.name = "StreamingNotSupportedError";
  }
}

export function normalizeChatRequest(body: unknown): NormalizedChatRequest {
  const record = body && typeof body === "object" ? body as Record<string, unknown> : {};
  if (record.stream === true) throw new StreamingNotSupportedError();
  const messages = Array.isArray(record.messages) ? record.messages.map(parseMessage) : [];
  if (messages.length === 0) throw new Error("messages_required");

  return {
    model: typeof record.model === "string" && record.model.trim() ? record.model.trim() : "trent-sonnet",
    messages,
    prompt: messages.map((msg) => `${msg.role}: ${msg.content}`).join("\n"),
    temperature: typeof record.temperature === "number" ? record.temperature : 0.7,
    maxTokens: typeof record.max_tokens === "number" ? record.max_tokens : 512,
  };
}

export async function buildChatCompletion(input: {
  companyId: string;
  request: NormalizedChatRequest;
}): Promise<{ response: Record<string, unknown>; route: ModelRoute; amountCents: number; inputTokens: number; outputTokens: number }> {
  const route = routeModel({ seat: "ceo", taskTier: "standard", reversibility: "reversible" });
  const inputTokens = estimateTokens(input.request.prompt);
  const content = deterministicCompletion(input.companyId, input.request.prompt);
  const outputTokens = estimateTokens(content);
  const amountCents = estimateModelCostCents({ modelTier: route.modelTier, inputTokens, outputTokens });

  return {
    route,
    amountCents,
    inputTokens,
    outputTokens,
    response: {
      id: makeId("chatcmpl"),
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: input.request.model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: inputTokens,
        completion_tokens: outputTokens,
        total_tokens: inputTokens + outputTokens,
      },
      trent: {
        provider: route.provider,
        modelTier: route.modelTier,
        fallbackChain: route.fallbackChain,
      },
    },
  };
}

function parseMessage(value: unknown): ChatMessage {
  const msg = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const role = msg.role === "system" || msg.role === "assistant" || msg.role === "tool" ? msg.role : "user";
  const content = typeof msg.content === "string" ? msg.content : "";
  if (!content.trim()) throw new Error("message_content_required");
  return { role, content: content.trim() };
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.trim().split(/\s+/).filter(Boolean).length * 1.35));
}

function deterministicCompletion(companyId: string, prompt: string): string {
  const digest = createHash("sha256").update(`${companyId}:${prompt}`).digest("hex").slice(0, 8);
  return `Trent proxy response ${digest}`;
}
