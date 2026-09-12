/**
 * lib/generation/moderation-filter.ts
 *
 * Pre-publish safety filter. Runs before every generation API call.
 *
 * Hard rule: a "block" verdict must prevent any provider API call from firing.
 * Routers throw ModerationBlockedError on block; API surface surfaces escalations
 * to the approval queue.
 *
 * Implementation: keyword/pattern matching only (synchronous, no I/O, no cost).
 * An optional LLM-backed check for borderline cases can be added later without
 * changing this module's interface.
 *
 * Verdict semantics:
 *  "pass"     — proceed to generation
 *  "block"    — hard stop; do not call any provider; throw ModerationBlockedError
 *  "escalate" — surface to human approval queue before proceeding
 */

import type { GenerationTaskType } from "@/lib/generation/cost-optimizer";

// ── Public types ──────────────────────────────────────────────────────────────

export type ModerationVerdict = "pass" | "block" | "escalate";

export type ModerationResult = {
  verdict: ModerationVerdict;
  /** Human-readable explanation of why the verdict was reached. */
  reason?: string;
  /** Policy category that triggered the verdict. */
  category?: string;
};

// ── Error types ───────────────────────────────────────────────────────────────

export class ModerationBlockedError extends Error {
  constructor(readonly result: ModerationResult) {
    super(result.reason ?? "Content blocked by moderation filter.");
    this.name = "ModerationBlockedError";
  }
}

// ── Pattern definitions ───────────────────────────────────────────────────────

type PatternRule = {
  pattern: RegExp;
  verdict: ModerationVerdict;
  category: string;
  reason: string;
};

const BLOCK_RULES: PatternRule[] = [
  {
    pattern: /\b(murder|kill|brutally\s+attack|how\s+to\s+kill|assassinat)\b/i,
    verdict:  "block",
    category: "violence",
    reason:   "Explicit violence or instructions for harm detected.",
  },
  {
    pattern: /\b(suicide\s+methods?|how\s+to\s+(kill|hang|overdose)\s+(yourself|oneself)|self.harm\s+instruction)\b/i,
    verdict:  "block",
    category: "self_harm",
    reason:   "Self-harm instructions detected.",
  },
  {
    pattern: /\b(sexual\s+content\s+involving\s+(a\s+)?(child|minor|underage)|csam|child\s+pornography)\b/i,
    verdict:  "block",
    category: "csam",
    reason:   "Content involving minors in a sexual context is strictly prohibited.",
  },
  {
    pattern: /\b(mocks?|degrades?|inferior|subhuman)\s+.{0,40}(jewish|black|muslim|hispanic|gay|trans|disabled)\b/i,
    verdict:  "block",
    category: "hate_speech",
    reason:   "Hate speech targeting a protected group detected.",
  },
  {
    pattern: /\b(synthesiz|manufactur|produc).{0,30}(methamphetamine|heroin|fentanyl|explosiv|pipe\s+bomb|sarin)\b/i,
    verdict:  "block",
    category: "illegal_activity",
    reason:   "Instructions for illegal substance or weapon manufacturing detected.",
  },
  {
    pattern: /\b(step.by.step\s+)?(instructions?\s+for|guide\s+(to|for)|how\s+to)\s+(mak|build|creat|assembl).{0,30}(bomb|pipe\s*bomb|weapon|explosive)\b/i,
    verdict:  "block",
    category: "illegal_activity",
    reason:   "Instructions for weapon or explosive construction detected.",
  },
];

const ESCALATE_RULES: PatternRule[] = [
  {
    pattern: /\b(sexually?\s+explicit|explicit\s+sexual|explicit\s+adult|nude|nudity|pornograph)\b/i,
    verdict:  "escalate",
    category: "adult_content",
    reason:   "Explicit adult content requires human approval before generation.",
  },
];

// ── checkModeration ───────────────────────────────────────────────────────────

/**
 * Synchronous keyword-based moderation check.
 *
 * Runs block rules first (higher precedence), then escalate rules.
 * Returns "pass" if no rule matches.
 *
 * @param prompt       The full generation prompt (or combined prompt + system prompt).
 * @param contentType  The type of content being generated (for future content-type-aware rules).
 */
export function checkModeration(
  prompt: string,
  _contentType: GenerationTaskType
): ModerationResult {
  // Block rules take precedence — check first
  for (const rule of BLOCK_RULES) {
    if (rule.pattern.test(prompt)) {
      return { verdict: "block", reason: rule.reason, category: rule.category };
    }
  }

  // Escalate rules — check second
  for (const rule of ESCALATE_RULES) {
    if (rule.pattern.test(prompt)) {
      return { verdict: "escalate", reason: rule.reason, category: rule.category };
    }
  }

  return { verdict: "pass" };
}
