/**
 * OpenAI-backed LLM judge — the edge adapter for `llm-judge-grader.ts`.
 *
 * This is the ONLY place the autoresearch judge touches the AI client. Keeping it
 * separate from the pure `llm-judge-grader.ts` means that module (and its unit
 * tests) stay dependency-free, while this file wires the real model behind the
 * `JudgeFn` seam. It is exercised by the live/integration eval, not unit tests.
 */

import { z } from "zod";
import { MODELS, MAX_TOKENS, callJson, type CallJsonOptions } from "@/lib/ai-client";
import type { JudgeFn, JudgeInput, JudgeVerdict } from "@/lib/self-improvement/llm-judge-grader";

const verdictSchema = z.object({
  pass: z.boolean(),
  score: z.number().min(0).max(1).optional(),
  reason: z.string().max(500).optional(),
});

export type CreateLlmJudgeOptions = {
  /** Override the judge model (defaults to the critic tier). */
  model?: string;
  /** Injected completion (tests) — forwarded to `callJson`. */
  callOpts?: CallJsonOptions;
};

const JUDGE_SYSTEM = [
  "You are a strict, fair evaluation judge for an AI agent's output.",
  "You are given ONE rubric assertion and the agent's output.",
  "Decide whether the output clearly satisfies the assertion.",
  'Respond ONLY as JSON: {"pass": boolean, "score": number between 0 and 1, "reason": short string}.',
  "Be conservative: if the output does not clearly satisfy the assertion, set pass=false.",
].join(" ");

/**
 * Build a `JudgeFn` backed by a real model. Use it with
 * `buildJudgedGradersFor(skill, livePrimedActuals, createLlmJudge())`.
 */
export function createLlmJudge(opts: CreateLlmJudgeOptions = {}): JudgeFn {
  const model = opts.model ?? MODELS.CRITIC;
  return async (input: JudgeInput): Promise<JudgeVerdict> => {
    const user = JSON.stringify(
      {
        assertion: input.rubric,
        task_input: input.input ?? null,
        expected_output: input.goldenOutput ?? null,
        agent_output: input.actual,
      },
      null,
      2,
    );
    const { data } = await callJson<JudgeVerdict>(
      model,
      JUDGE_SYSTEM,
      user,
      verdictSchema,
      MAX_TOKENS.JSON,
      opts.callOpts,
    );
    return data;
  };
}
