/**
 * The governance blocks of `TrentConfigSchema`: `privacy`, `policy`, and the three keys whose
 * schemas live with the code that enforces them — `autonomy`, `approvals` and `hooks`, re-exported
 * here so `config/schema.ts` names one governance module instead of three. Composed in
 * `config/schema.ts`; the prose for each key sits at the key it documents.
 */

import { z } from "zod";
import { PolicyRuleSchema } from "../../governance/policy-rules.js";
import { AutoReviewConfigSchema } from "../../governance/auto-review-config.js"; // [H1] auto review

// [A2.2] autonomy and hooks
export { ApprovalsConfigSchema, AutonomyLevelSchema, DEFAULT_AUTONOMY } from "../../governance/autonomy.js";
export { HooksConfigSchema } from "../../hooks/types.js";

/** Prompt-side redaction in the model gateway (docs/security.md, "Prompt redaction"). */
export const PrivacyConfigSchema = z.object({
  redact_prompts: z.boolean().default(false),
  patterns: z.array(z.string()).default([]),
});

/** Trace-level rules over tool classes; appended to the shipped defaults, same id overrides. */
export const PolicyConfigSchema = z.object({
  rules: z.array(PolicyRuleSchema).default([]),
});

// [H1] auto review
/**
 * `governance`: the written policy an auto reviewer works inside (docs/security.md, "Auto review").
 * `auto_review` is defined beside the code that enforces it (`governance/auto-review-config.ts`,
 * evaluated by `governance/auto-review-policy.ts`); off by default, and with `max_class: read` even
 * turning it on approves nothing until a ceiling, a cap or a recipient list is written down.
 */
export const GovernanceConfigSchema = z
  .object({
    auto_review: AutoReviewConfigSchema.default({}),
  })
  .strict();
export { AutoReviewConfigSchema };
// [/H1]
