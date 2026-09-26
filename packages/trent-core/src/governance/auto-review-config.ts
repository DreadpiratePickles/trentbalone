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

export const AutoReviewConfigSchema = z
  .object({
    /** Off by default. Off means the reviewer never runs and no row, file or ledger is touched. */
    enabled: z.boolean().default(false),
    /** A model pin for the reviewer (a local model is allowed). Absent: the profile's own `model`. */
    model: z.string().trim().min(1).optional(),
    /** The highest tier the reviewer may approve. `execute`, `destructive`, `deploy` and `secret_access` are never approvable. */
    max_class: z.enum(AUTO_REVIEW_TIERS).default("read"),
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
