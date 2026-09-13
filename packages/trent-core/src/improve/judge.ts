/**
 * The evidence-cited judge (task I.7; CS329A L9 @18:03-19:08 meta-verification).
 *
 * The app's rubric judging is the one verifier class the course measured as worse than majority
 * voting, so the wrapper's judge is held to a stricter contract than "pass or fail": it must
 * quote a short substring of the output as the evidence for a pass. `gate-score.ts` then checks,
 * deterministically and at no extra call, that the quote really is in the output; a pass whose
 * evidence is not there scores 0 and is tagged `judge_unverified`.
 *
 * `createGatewayJudge` binds the contract to the real model gateway at temperature 0 and returns
 * integer cents from the gateway's own usage. A reply that is not the expected JSON is a FAIL
 * with a reason, never a pass: an unparseable judge cannot certify anything. The prompt body
 * (rubric, fixture, output) is sent to the model and never logged.
 */

import type { GatewayMessage, ModelGateway } from "../model-gateway/types.js";
import type { JudgeFn, JudgeVerdict } from "./gate-types.js";

const JUDGE_SYSTEM_PROMPT = [
  "You grade one output against one rubric assertion.",
  "Reply with a single JSON object and nothing else:",
  '{"pass": true|false, "evidence": "<exact substring of the OUTPUT that satisfies the assertion, 8-120 characters>", "reason": "<one sentence>"}',
  "The evidence MUST be copied verbatim from the OUTPUT. If the assertion is not satisfied, pass is false and evidence is an empty string.",
  "Do not pass an output on the strength of its tone or length; pass only on content the evidence shows.",
].join("\n");

export interface GatewayJudgeOptions {
  readonly maxTokens?: number;
}

/** Parses the judge's reply. Anything but a JSON object with a boolean `pass` is a fail. */
export function parseJudgeReply(text: string): JudgeVerdict {
  try {
    const match = text.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(match ? match[0] : text) as { pass?: unknown; evidence?: unknown; reason?: unknown };
    if (typeof parsed.pass !== "boolean") return { pass: false, reason: "judge reply had no boolean pass" };
    const evidence = typeof parsed.evidence === "string" ? parsed.evidence.trim() : "";
    const reason = typeof parsed.reason === "string" ? parsed.reason : undefined;
    // A pass with no evidence carries the empty citation, which gate-score.ts refuses to verify.
    return { pass: parsed.pass, evidence, ...(reason === undefined ? {} : { reason }) };
  } catch {
    return { pass: false, reason: "judge reply was not JSON" };
  }
}

function judgeUserPrompt(rubric: string, prompt: string, goldenOutput: string | undefined, output: string, toolCalls: readonly string[]): string {
  return [
    `ASSERTION: ${rubric}`,
    `TASK PROMPT: ${prompt}`,
    ...(goldenOutput === undefined ? [] : [`REFERENCE (what a good answer covers): ${goldenOutput}`]),
    ...(toolCalls.length === 0 ? [] : [`TOOL CALLS MADE: ${toolCalls.join(", ")}`]),
    "OUTPUT:",
    output,
  ].join("\n\n");
}

export function createGatewayJudge(gateway: ModelGateway, options: GatewayJudgeOptions = {}): JudgeFn {
  return async ({ rubric, prompt, goldenOutput, actual }) => {
    const messages: GatewayMessage[] = [
      { role: "system", content: JUDGE_SYSTEM_PROMPT },
      { role: "user", content: judgeUserPrompt(rubric, prompt, goldenOutput, actual.text, actual.toolCalls) },
    ];
    const completion = await gateway.complete({ messages, role: "executor", maxTokens: options.maxTokens ?? 256, temperature: 0 });
    return { ...parseJudgeReply(completion.text), costCents: Math.max(0, Math.trunc(completion.costCents)) };
  };
}
