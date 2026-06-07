import type { ToolAdapter } from "@/lib/tools";
import type { ToolCallRecord } from "@/lib/types";

export type GuardrailTripwire = "policy_violation" | "missing_content" | "blocked_recipient";

export type GuardrailCheckResult = {
  passed: boolean;
  tripwire?: GuardrailTripwire;
  reason?: string;
};

const EXTERNAL_SEND_KEYWORDS = [
  "send",
  "publish",
  "post",
  "email",
  "dm",
  "reply",
  "broadcast",
  "launch campaign",
];

const POLICY_VIOLATION_PATTERNS: RegExp[] = [
  /guaranteed\s+(\d+%?\s*)?returns/i,
  /wire\s+(transfer|money)/i,
  /100%\s+(profit|return)/i,
  /not\s+a\s+scam/i,
  /click\s+here\s+to\s+claim/i,
  /ssn|social security/i,
];

export function isExternalSendAction(action: string): boolean {
  const haystack = action.toLowerCase();
  return EXTERNAL_SEND_KEYWORDS.some((keyword) => haystack.includes(keyword));
}

function extractSendContent(payload: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const key of ["body", "subject", "message", "content", "text", "summary"]) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) parts.push(value);
  }
  return parts.join("\n");
}

export function checkExternalActionInputGuardrail(input: {
  action: string;
  payload: Record<string, unknown>;
}): GuardrailCheckResult {
  if (!isExternalSendAction(input.action)) return { passed: true };
  const content = extractSendContent(input.payload);
  if (!content.trim()) {
    return { passed: false, tripwire: "missing_content", reason: "External send missing message content." };
  }
  return { passed: true };
}

export function checkExternalSendOutputGuardrail(input: {
  action: string;
  payload: Record<string, unknown>;
  resultSummary?: string;
}): GuardrailCheckResult {
  if (!isExternalSendAction(input.action)) return { passed: true };
  const content = [extractSendContent(input.payload), input.resultSummary ?? ""].filter(Boolean).join("\n");
  for (const pattern of POLICY_VIOLATION_PATTERNS) {
    if (pattern.test(content)) {
      return {
        passed: false,
        tripwire: "policy_violation",
        reason: `Output guardrail blocked external send: content matches policy violation (${pattern.source}).`,
      };
    }
  }
  return { passed: true };
}

export async function executeExternalActionWithGuardrails(input: {
  adapter: ToolAdapter;
  action: string;
  payload: Record<string, unknown>;
  approvalGranted: boolean;
}): Promise<ToolCallRecord> {
  const inputGuardrail = checkExternalActionInputGuardrail({
    action: input.action,
    payload: input.payload,
  });
  if (!inputGuardrail.passed) {
    return {
      adapter: input.adapter.name,
      action: input.action,
      status: "blocked",
      summary: inputGuardrail.reason ?? "Input guardrail blocked external action.",
    };
  }

  const needsApproval = input.adapter.requiresApproval(input.action);
  if (needsApproval && !input.approvalGranted) {
    if (input.adapter.dryRun) {
      return input.adapter.dryRun(input.action, input.payload);
    }
    return {
      adapter: input.adapter.name,
      action: input.action,
      status: "needs_approval",
      summary: `${input.adapter.name} action requires approval before execution.`,
    };
  }

  const [executeResult, outputGuardrail] = await Promise.all([
    input.adapter.execute(input.action, input.payload),
    Promise.resolve(checkExternalSendOutputGuardrail({
      action: input.action,
      payload: input.payload,
    })),
  ]);

  const postOutputGuardrail = checkExternalSendOutputGuardrail({
    action: input.action,
    payload: input.payload,
    resultSummary: executeResult.summary,
  });

  const blocked = !outputGuardrail.passed ? outputGuardrail : !postOutputGuardrail.passed ? postOutputGuardrail : undefined;
  if (blocked) {
    return {
      adapter: input.adapter.name,
      action: input.action,
      status: "blocked",
      summary: blocked.reason ?? "Output guardrail blocked external action.",
    };
  }

  return executeResult;
}
