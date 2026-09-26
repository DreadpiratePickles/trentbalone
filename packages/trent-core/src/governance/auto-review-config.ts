/**
 * [H1] `governance.auto_review` in `config.yaml`: the written policy of what the auto reviewer MAY
 * approve, and the two fields the reviewer leaves on an approval row.
 *
 * This is a leaf module on purpose (zod and one type import): `config/sections/governance.ts` composes
 * the schema into `TrentConfigSchema`, and `bound-approvals.ts` calls `stampAutoReviewGrantUse` from
 * its `require()`, so nothing here may import either of them back.
 *
 * The policy only ever NARROWS: the reviewer can approve nothing the class floor, the hardline
 * blocklist, the approval floor or an `approvals.deny` glob refuses, and nothing outside these keys
 * (`auto-review-policy.ts` is the evaluator). Off by default; `max_class: read` by default, which is
 * below every class a held call carries, so turning the switch on alone approves nothing.
 */
import { z } from "zod";

/** The ceiling ladder, lowest first. Each tier includes every tier below it. */
export const AUTO_REVIEW_TIERS = ["read", "write", "external_send", "money"] as const;
export type AutoReviewTier = (typeof AUTO_REVIEW_TIERS)[number];

// [C3] README.md:11-13: anything that sends a message or moves money asks the owner first at every
// autonomy level, so a reviewer model never approves one. `external_send` and `money` stay on the
// ladder to PLACE a call (`tierOfClasses`); no config may name them as a ceiling. The type keeps the
// whole ladder on purpose: a config object can reach the policy without this schema, and the policy
// refuses above the ceiling on its own. Raising it waits for structural taint on bound rows.
/** The highest tier a reviewer may ever be given. */
export const AUTO_REVIEW_CEILING: AutoReviewTier = "write";
/** The promise a higher ceiling would break, named in the config error and in the policy's refusal. */
export const ASKS_YOU_FIRST = "Trent asks you first for every send and every payment";

/** `read` and `write`: the only tiers a reviewer may approve. */
export function isApprovableTier(tier: AutoReviewTier): boolean {
  return AUTO_REVIEW_TIERS.indexOf(tier) <= AUTO_REVIEW_TIERS.indexOf(AUTO_REVIEW_CEILING);
}

const ceilingMessage = (value: unknown): string => `auto_review.max_class: ${String(value)} is not allowed: ${ASKS_YOU_FIRST}; the highest a reviewer may approve is ${AUTO_REVIEW_CEILING}`;
// [/C3]

export const AutoReviewConfigSchema = z
  .object({
    /** Off by default. Off means the reviewer never runs and no row, file or ledger is touched. */
    enabled: z.boolean().default(false),
    /** A model pin for the reviewer (a local model is allowed). Absent: the profile's own `model`. */
    model: z.string().trim().min(1).optional(),
    /** The highest tier the reviewer may approve: `read` or `write` [C3]. `execute`, `destructive`, `deploy` and `secret_access` are never approvable. */
    max_class: z
      .enum(AUTO_REVIEW_TIERS, { errorMap: (_issue, ctx) => ({ message: ceilingMessage(ctx.data) }) }) // [C3] every refusal names the key and the promise
      .refine(isApprovableTier, (tier) => ({ message: ceilingMessage(tier) })) // [C3] external_send and money are a person's
      .default("read"),
    // [C3] The three keys below bound a send or a payment for the day the ceiling is raised; while it is
    // `write`, no send and no money call is approvable whatever they say.
    /** A money call is in policy only at or under this total, in integer cents of `currency`. 0: no money call is. */
    max_amount_cents: z.number().int().nonnegative().default(0),
    /** The one currency the cap is in (ISO 4217, stored lower-case); a call in any other is escalated. */
    currency: z
      .string()
      .regex(/^[A-Za-z]{3}$/, "currency must be a three-letter ISO 4217 code such as usd")
      .transform((code) => code.toLowerCase())
      .default("usd"),
    /** Who a send may reach: exact addresses, phone numbers or hosts, or a `*` prefix glob (`*@example.com`). Empty: no send is in policy. */
    recipients: z.array(z.string().trim().min(1)).default([]),
  })
  .strict();

export type AutoReviewConfig = z.infer<typeof AutoReviewConfigSchema>;

export const DEFAULT_AUTO_REVIEW: AutoReviewConfig = AutoReviewConfigSchema.parse({});

/** Every reviewer decision's actor starts with this: `auto-review:<model>`, or `auto-review:policy` when no model was asked. */
export const AUTO_REVIEW_ACTOR_PREFIX = "auto-review:";
export const POLICY_ACTOR = `${AUTO_REVIEW_ACTOR_PREFIX}policy`;

export function isAutoReviewActor(actor: string | undefined): boolean {
  return typeof actor === "string" && actor.startsWith(AUTO_REVIEW_ACTOR_PREFIX);
}

/** `details.autoReview` on a reviewed row: what the reviewer decided, why, and who overrode it. */
export const AUTO_REVIEW_FIELD = "autoReview";
/** `details.autoReviewGrantUsedAt`: the instant a reviewer's approval was first honoured, i.e. the call ran. */
export const GRANT_USED_FIELD = "autoReviewGrantUsedAt";

interface StampableRow {
  readonly decidedBy?: string;
  readonly details: Record<string, unknown>;
}

/**
 * The body of the one `// [H1]` hook in `bound-approvals.ts` `require()`. A grant the reviewer
 * decided is marked the first time it is honoured, because that is the moment the call runs: a bound
 * approval releases nothing by itself, the identical call's replay does. A human's grant is never
 * touched, so with the reviewer off no row changes shape.
 */
export function stampAutoReviewGrantUse(row: StampableRow, now: Date = new Date()): void {
  if (!isAutoReviewActor(row.decidedBy)) return;
  if (typeof row.details[GRANT_USED_FIELD] === "string") return;
  row.details[GRANT_USED_FIELD] = now.toISOString();
}

/** When a reviewer's grant was used, if it was. */
export function autoReviewGrantUsedAt(row: Pick<StampableRow, "details">): string | undefined {
  const used = row.details[GRANT_USED_FIELD];
  return typeof used === "string" ? used : undefined;
}
