/**
 * The `createCompletion` port, served by the real model gateway.
 *
 * `callJson` (apps/web/lib/ai-client.ts:293-360) is the planner's and critic's only way to a
 * model. Its default path is OpenAI-only: it throws "OPENAI_API_KEY is not configured" for a
 * Google user, and the planner then substitutes a canned plan while the critic auto-passes (live
 * proof, finding 1). `callJson` does, however, accept an injected `createCompletion(model,
 * messages, maxTokens)`; this module is that function, routed through `ModelGateway.complete` so
 * the call reaches the CONFIGURED provider and model (the gateway resolves them from the env that
 * `applyModelEnv` wrote).
 *
 * Two facts shape it:
 *  - The `model` argument is the pipeline's OpenAI name (`PLANNER_MODEL` / `CRITIC_MODEL`, both
 *    `gpt-5.2` by default). It is ignored for routing; the gateway's `planner` role picks the
 *    strong tier of the configured provider.
 *  - Every `callJson` caller wants a JSON object, but the gateway's stream API has no
 *    `response_format`. The port asks for JSON in the system message and isolates the first JSON
 *    object from the reply (Gemini likes a lead-in sentence and ```json fences), so the strict
 *    `JSON.parse` in `callJson` sees only the object.
 *
 * With no configured provider at all the port throws a message containing "not configured": that
 * exact wording is what `orchestrator-runtime.ts` (`isNotConfiguredError`) treats as benign offline
 * mode, which keeps the deterministic fallback for a user with no key and nothing else.
 */

import { PROVIDER_ENV_VARS } from "../setup/detect.js";
import type { GatewayMessage, ModelGateway, StreamRole } from "./types.js";

/** The `messages` shape `callJson` builds (OpenAI `ChatCompletionMessageParam`, narrowed). */
export interface CompletionPortMessage {
  readonly role: string;
  readonly content?: unknown;
}

/** Mirrors `CallJsonOptions["createCompletion"]` in apps/web/lib/ai-client.ts. */
export type CreateCompletionFn = (
  model: string,
  messages: ReadonlyArray<CompletionPortMessage>,
  maxTokens: number,
) => Promise<{ content: string | null; totalTokens: number }>;

/** One port call as reported to the observer. Never carries prompt or reply text. */
export interface CompletionPortCall {
  readonly ok: boolean;
  readonly error?: string;
  /** True when the failure is "no provider configured" — offline mode, not a provider fault. */
  readonly offline: boolean;
}

export interface CompletionPortOptions {
  /** Gateway role used for routing. Defaults to `planner` (the strong tier). */
  readonly role?: StreamRole;
  readonly temperature?: number;
  readonly onCall?: (call: CompletionPortCall) => void;
}

const JSON_INSTRUCTION =
  "Respond with exactly one JSON object and nothing else: no prose before or after it and no markdown fences.";

/** Every provider key variable, from the one table `trent setup` detects keys with, so the two cannot drift. */
const PROVIDER_KEY_NAMES: readonly string[] = [...new Set(Object.values(PROVIDER_ENV_VARS).flat())];

export const NOT_CONFIGURED_MESSAGE = `model provider is not configured: no API key found (${PROVIDER_KEY_NAMES.slice(0, -1).join(", ")} or ${PROVIDER_KEY_NAMES[PROVIDER_KEY_NAMES.length - 1] ?? ""})`;

function contentToString(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === "string" ? part : typeof part?.text === "string" ? part.text : ""))
      .join("");
  }
  return content == null ? "" : String(content);
}

function toGatewayMessages(messages: ReadonlyArray<CompletionPortMessage>): GatewayMessage[] {
  const out: GatewayMessage[] = [];
  for (const message of messages) {
    const role = message.role === "system" || message.role === "assistant" ? message.role : "user";
    out.push({ role, content: contentToString(message.content) });
  }
  if (out.length > 0 && out[0]!.role === "system") {
    out[0] = { role: "system", content: `${out[0]!.content}\n\n${JSON_INSTRUCTION}` };
  } else {
    out.unshift({ role: "system", content: JSON_INSTRUCTION });
  }
  return out;
}

/**
 * Returns the first complete JSON object in `text`, or `text` unchanged when there is none (so the
 * caller's "returned non-JSON" error shows what the model actually said). Handles fences, lead-in
 * prose and trailing commentary; strings containing braces are respected.
 */
export function extractJsonObject(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    try {
      JSON.parse(trimmed);
      return trimmed;
    } catch {
      /* fall through to the scan */
    }
  }
  const start = trimmed.indexOf("{");
  if (start === -1) return text;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < trimmed.length; index += 1) {
    const char = trimmed[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        const candidate = trimmed.slice(start, index + 1);
        try {
          JSON.parse(candidate);
          return candidate;
        } catch {
          return text;
        }
      }
    }
  }
  return text;
}

export function createCompletionPort(gateway: ModelGateway, options: CompletionPortOptions = {}): CreateCompletionFn {
  const role = options.role ?? "planner";
  return async (_model, messages, maxTokens) => {
    if (gateway.configuredProviders().length === 0) {
      options.onCall?.({ ok: false, error: NOT_CONFIGURED_MESSAGE, offline: true });
      throw new Error(NOT_CONFIGURED_MESSAGE);
    }
    try {
      const completion = await gateway.complete({
        role,
        messages: toGatewayMessages(messages),
        maxTokens,
        temperature: options.temperature ?? 0.2,
      });
      options.onCall?.({ ok: true, offline: false });
      return {
        content: completion.text.trim() === "" ? null : extractJsonObject(completion.text),
        totalTokens: completion.inputTokens + completion.outputTokens,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      options.onCall?.({ ok: false, error: message, offline: /not configured/i.test(message) });
      throw error;
    }
  };
}
