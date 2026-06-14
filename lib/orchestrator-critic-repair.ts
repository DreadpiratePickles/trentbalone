/**
 * lib/orchestrator-critic-repair.ts — robust critic JSON parsing.
 *
 * The critic LLM occasionally returns output that fails schema validation
 * (e.g. a boolean where a string is expected, or a stray markdown fence). Simple
 * type mismatches are coerced at the schema level (see requiredStringSchema in
 * orchestrator-runtime). Anything the schema can't coerce gets ONE repair retry
 * with the validation error injected into the prompt — the same pattern as
 * callJsonWithRepair, but threading the test `createCompletion` override the
 * critic relies on, and emitting structured repair telemetry.
 *
 * Safety: a real INFRASTRUCTURE failure (no API key, network/provider error) is
 * NOT repairable — retrying would only burn another call and fail again — so we
 * rethrow immediately and let the caller's existing degradation/escalation path
 * decide. We never silently pass a malformed critic verdict.
 */
import type { z } from "zod";
import type { CallJsonOptions } from "@/lib/ai-client";
import { callJson } from "@/lib/ai-client";

export type CriticRepairTelemetryEvent =
  | "critic_schema_repair_attempted"
  | "critic_schema_repair_succeeded"
  | "critic_schema_repair_failed";

export type CriticRepairTelemetryMeta = {
  model: string;
  companyId?: string;
  runId?: string;
  /** A short error CLASS/message — never the prompt contents. */
  error?: string;
};

export type CriticRepairTelemetry = (
  event: CriticRepairTelemetryEvent,
  meta: CriticRepairTelemetryMeta,
) => void;

/**
 * A failure is repairable when it looks like a parse/validation problem with the
 * model's JSON. Infrastructure failures ("not configured", network, provider)
 * are explicitly excluded so we never waste a retry that cannot help.
 */
export function isRepairableCriticError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  if (/not configured|network|fetch failed|timeout|ECONN|rate limit|429|5\d\d\b/i.test(message)) {
    return false;
  }
  return /schema|validation|parse|json|unexpected token|expected .* received|invalid/i.test(message);
}

/** Default telemetry sink: structured log, no prompt contents. */
export function logCriticRepairTelemetry(
  event: CriticRepairTelemetryEvent,
  meta: CriticRepairTelemetryMeta,
): void {
  // Intentionally a single structured line; callers' prompts are never included.
  console.info("orchestrator.critic_repair", { event, ...meta });
}

export async function callCriticJsonWithRepair<T>(opts: {
  model: string;
  system: string;
  user: string;
  schema: z.ZodTypeAny;
  maxTokens: number;
  createCompletion?: CallJsonOptions["createCompletion"];
  onTelemetry?: CriticRepairTelemetry;
  meta?: { companyId?: string; runId?: string };
}): Promise<{ data: T; tokens: number; repaired: boolean }> {
  const callOpts: CallJsonOptions = { createCompletion: opts.createCompletion };
  const telemetry = opts.onTelemetry;
  const baseMeta: CriticRepairTelemetryMeta = {
    model: opts.model,
    companyId: opts.meta?.companyId,
    runId: opts.meta?.runId,
  };

  try {
    const first = await callJson<T>(opts.model, opts.system, opts.user, opts.schema, opts.maxTokens, callOpts);
    return { data: first.data, tokens: first.tokens, repaired: false };
  } catch (firstErr) {
    if (!isRepairableCriticError(firstErr)) throw firstErr;

    const reason = firstErr instanceof Error ? firstErr.message : String(firstErr);
    telemetry?.("critic_schema_repair_attempted", { ...baseMeta, error: trimError(reason) });

    const repairUser = [
      opts.user,
      "",
      "Your previous response could not be parsed/validated:",
      reason.slice(0, 600),
      "",
      "Return ONLY a single valid JSON object that satisfies the required schema. No prose, no markdown fences.",
    ].join("\n");

    try {
      const second = await callJson<T>(opts.model, opts.system, repairUser, opts.schema, opts.maxTokens, callOpts);
      telemetry?.("critic_schema_repair_succeeded", baseMeta);
      return { data: second.data, tokens: second.tokens, repaired: true };
    } catch (secondErr) {
      const secondReason = secondErr instanceof Error ? secondErr.message : String(secondErr);
      telemetry?.("critic_schema_repair_failed", { ...baseMeta, error: trimError(secondReason) });
      throw secondErr;
    }
  }
}

function trimError(message: string): string {
  return message.slice(0, 200);
}
