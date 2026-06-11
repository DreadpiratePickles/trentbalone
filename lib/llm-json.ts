/**
 * lib/llm-json.ts — §1 P0-3: structured LLM calls with a repair retry instead of
 * a silent fallback. On a parse/validation failure we retry ONCE with the
 * validation error injected into the prompt (the workbench repair pattern), then
 * surface the failure to the caller so it can mark the result degraded — never a
 * silent canned plan.
 */
import { z } from "zod";
import { callJson, MAX_TOKENS } from "@/lib/ai-client";

export class LlmJsonError extends Error {
  constructor(message: string, readonly lastContent?: string) {
    super(message);
    this.name = "LlmJsonError";
  }
}

export async function callJsonWithRepair<T>(opts: {
  model: string;
  system: string;
  user: string;
  schema: z.ZodTypeAny;
  maxTokens?: number;
}): Promise<{ data: T; tokens: number; repaired: boolean }> {
  const maxTokens = opts.maxTokens ?? MAX_TOKENS.JSON;
  try {
    const first = await callJson<T>(opts.model, opts.system, opts.user, opts.schema, maxTokens);
    return { data: first.data, tokens: first.tokens, repaired: false };
  } catch (firstErr) {
    const reason = firstErr instanceof Error ? firstErr.message : String(firstErr);
    const repairUser = [
      opts.user,
      "",
      "Your previous response could not be parsed/validated:",
      reason.slice(0, 600),
      "",
      "Return ONLY a single valid JSON object that satisfies the required schema. No prose, no markdown fences.",
    ].join("\n");
    try {
      const second = await callJson<T>(opts.model, opts.system, repairUser, opts.schema, maxTokens);
      return { data: second.data, tokens: second.tokens, repaired: true };
    } catch (secondErr) {
      const msg = secondErr instanceof Error ? secondErr.message : String(secondErr);
      throw new LlmJsonError(`LLM JSON call failed after repair retry: ${msg}`);
    }
  }
}
