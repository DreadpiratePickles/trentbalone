/**
 * [H1] The policy evaluator: is a held row even eligible for the auto reviewer's verdict?
 *
 * Pure and deterministic (rulebook principle 6: permissions are computed by code). The model is asked
 * only about a row this function calls eligible; everything else is escalated to the human with the
 * rule named and no model call. The model can therefore never approve outside the written policy,
 * whatever its reply says. Rules, in the order they are checked:
 *
 *   disabled               `governance.auto_review.enabled` is false
 *   not_bound_call         not a call bound to its arguments (a run approval, a question, a held write)
 *   not_pending            already decided
 *   untrusted_provenance   the preview, the action or the arguments carry an untrusted-provenance marker
 *   hardline               the hardline blocklist names it (`hardline.ts`)
 *   approval_floor         the approval floor refuses it (`tools/approval-floors.ts` floorBlock)
 *   deny_glob              an `approvals.deny` glob matches it (`deny-globs.ts`)
 *   unclassified           no class could be read off it
 *   never_class            it executes, destroys, deploys or touches a secret
 *   class_above_max        its tier is above `max_class`
 *   money_amount_unknown   a money call whose total in integer cents cannot be read
 *   money_currency         a money call in another currency than the cap's
 *   money_over_cap         a money call over `max_amount_cents`
 *   recipient_unknown      a send that names no recipient (a public post, an invoice id alone)
 *   recipient_not_allowed  a send to anyone not on `recipients`
 *   send_or_money          [C3] a send or a payment that passed every rule above: always a person's
 *                          (README.md:11-13). The schema caps `max_class` at `write`, so only a config
 *                          that skipped it gets here; the policy refuses on its own all the same.
 */
import { floorBlock } from "../tools/approval-floors.js";
import { provenanceMarker } from "../tools/memory/holds.js";
import type { ApprovalRow } from "../gateway/store/GatewayStore.js";
import type { AutoReviewConfig, AutoReviewTier } from "./auto-review-config.js";
import { ASKS_YOU_FIRST, AUTO_REVIEW_TIERS, isApprovableTier } from "./auto-review-config.js"; // [C3] ASKS_YOU_FIRST, isApprovableTier
import { subjectsOfAction } from "./autonomy-dispatch.js";
import { BOUND_CALL_KIND } from "./bound-approvals.js";
import { denyMatch } from "./deny-globs.js";
import { hardlineBlock, type HardlineContext } from "./hardline.js";
import { POLICY_CLASSES, classifyCall, type PolicyClass } from "./policy-rules.js";

export type AutoReviewRule =
  | "disabled"
  | "not_bound_call"
  | "not_pending"
  | "untrusted_provenance"
  | "hardline"
  | "approval_floor"
  | "deny_glob"
  | "unclassified"
  | "never_class"
  | "class_above_max"
  | "money_amount_unknown"
  | "money_currency"
  | "money_over_cap"
  | "recipient_unknown"
  | "recipient_not_allowed"
  | "send_or_money"; // [C3]

export interface AutoReviewPolicyContext {
  readonly hardline: HardlineContext;
  /** `approvals.deny` from the profile. */
  readonly deny?: readonly string[];
}

export type AutoReviewPolicyVerdict =
  | {
      readonly eligible: true;
      readonly tier: AutoReviewTier;
      readonly classes: readonly PolicyClass[];
      readonly recipients: readonly string[];
      /** Integer cents in the policy's currency, on a money call. */
      readonly amountCents?: number;
    }
  | { readonly eligible: false; readonly rule: AutoReviewRule; readonly reason: string };

/**
 * Marker strings that mean "derived from text somebody outside this machine wrote": the prefix of the
 * provenance marker an approved untrusted memory write carries (`tools/memory/holds.ts`), and the
 * line marker recall prints on untrusted memory (`fleet-memory/recall.ts` UNTRUSTED_MARKER, pinned
 * equal by the test rather than imported, because recall pulls in the app's agent catalog).
 */
export const UNTRUSTED_STRINGS: readonly string[] = [provenanceMarker([]).split(" via")[0] ?? "[provenance: untrusted", "[untrusted]"];

/** Classes no policy can make approvable: a reviewer never runs code, destroys, deploys or reads a secret. */
export const NEVER_AUTO_CLASSES: readonly PolicyClass[] = ["execute", "destructive", "deploy", "secret_access"];

const TIER_OF_CLASS: Readonly<Record<PolicyClass, AutoReviewTier | "never">> = {
  read_only: "read",
  inbound: "read",
  write: "write",
  external_send: "external_send",
  customer_facing: "external_send",
  network: "external_send",
  money_moving: "money",
  execute: "never",
  destructive: "never",
  deploy: "never",
  secret_access: "never",
};

/** Classes whose call reaches somebody, so every recipient must be on the allowlist. */
const SENDING_CLASSES: readonly PolicyClass[] = ["external_send", "customer_facing", "network"];

/** The highest tier among `classes`; `never` when any class is never approvable. Empty classes read as `read`. */
export function tierOfClasses(classes: readonly PolicyClass[]): AutoReviewTier | "never" {
  let best = 0;
  for (const cls of classes) {
    const tier = TIER_OF_CLASS[cls];
    if (tier === "never") return "never";
    best = Math.max(best, AUTO_REVIEW_TIERS.indexOf(tier));
  }
  return AUTO_REVIEW_TIERS[best] ?? "read";
}

const isPositiveInteger = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value > 0;

/**
 * A money call's total in integer cents: its `items` (`amount_cents` x `quantity`, the business
 * tools' shape, `tools/business/money.ts`), else `expected_total_cents`, else `amount_cents`.
 * Undefined when none is readable or any line is not a positive integer — never a guess.
 */
export function amountCentsOf(args: unknown): number | undefined {
  if (args === null || typeof args !== "object") return undefined;
  const bag = args as Record<string, unknown>;
  if (Array.isArray(bag.items)) {
    if (bag.items.length === 0) return undefined;
    let total = 0;
    for (const entry of bag.items) {
      if (entry === null || typeof entry !== "object") return undefined;
      const { amount_cents: unit, quantity } = entry as Record<string, unknown>;
      if (!isPositiveInteger(unit)) return undefined;
      if (quantity !== undefined && !isPositiveInteger(quantity)) return undefined;
      total += unit * (quantity ?? 1);
    }
    return total;
  }
  if (isPositiveInteger(bag.expected_total_cents)) return bag.expected_total_cents;
  if (isPositiveInteger(bag.amount_cents)) return bag.amount_cents;
  return undefined;
}

/** Argument keys that name who a call reaches. */
const RECIPIENT_KEYS: ReadonlySet<string> = new Set([
  "to", "cc", "bcc", "recipient", "recipients", "email", "emails", "phone", "phone_number",
  "customer", "attendee", "attendees", "peer", "channel", "channel_id", "chat_id", "url", "host",
]);
const PHONE = /^\+?[\d\s().-]{6,}$/;

/** Lower-cased and trimmed; a phone number loses its spacing and punctuation so `+1 555 0100` is `+15550100`. */
export function normaliseRecipient(value: string): string {
  const trimmed = value.trim().toLowerCase();
  if (PHONE.test(trimmed)) return trimmed.replace(/[^\d+]/g, "");
  return trimmed;
}

function hostOf(value: string): string {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return value;
  }
}

function collect(key: string, value: unknown, out: string[]): void {
  if (typeof value === "string") {
    if (value.trim() !== "") out.push(normaliseRecipient(key === "url" ? hostOf(value) : value));
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collect(key, item, out);
    return;
  }
  if (value !== null && typeof value === "object") {
    const nested = value as Record<string, unknown>;
    for (const field of ["email", "phone", "id"]) if (typeof nested[field] === "string") collect(field, nested[field], out);
  }
}

/** Every recipient the arguments name, top level and one object down, normalised, without repeats. */
export function recipientsOf(args: unknown): string[] {
  if (args === null || typeof args !== "object" || Array.isArray(args)) return [];
  const out: string[] = [];
  const visit = (bag: Record<string, unknown>, depth: number): void => {
    for (const [key, value] of Object.entries(bag)) {
      const name = key.toLowerCase();
      if (RECIPIENT_KEYS.has(name)) collect(name, value, out);
      else if (depth === 0 && value !== null && typeof value === "object" && !Array.isArray(value)) visit(value as Record<string, unknown>, 1);
    }
  };
  visit(args as Record<string, unknown>, 0);
  return [...new Set(out)];
}

/** An exact match, or a `*` prefix glob matched as a suffix: `*@example.com`, `*.example.com`. */
export function recipientAllowed(recipient: string, allowlist: readonly string[]): boolean {
  const target = normaliseRecipient(recipient);
  return allowlist.some((entry) => {
    const rule = entry.trim().toLowerCase();
    if (rule.startsWith("*")) return rule.length > 1 && target.endsWith(rule.slice(1));
    return normaliseRecipient(rule) === target;
  });
}

const refuse = (rule: AutoReviewRule, reason: string): AutoReviewPolicyVerdict => ({ eligible: false, rule, reason });

interface BoundDetails {
  readonly adapter: string;
  readonly tool: string;
  readonly args: unknown;
  readonly preview: string;
  readonly classes: readonly PolicyClass[];
}

function boundDetailsOf(row: ApprovalRow): BoundDetails | undefined {
  const d = row.details as Record<string, unknown>;
  if (d.kind !== BOUND_CALL_KIND || typeof d.preview !== "string" || typeof d.adapter !== "string" || typeof d.tool !== "string") return undefined;
  const classes = Array.isArray(d.classes) ? d.classes.filter((c): c is PolicyClass => (POLICY_CLASSES as readonly string[]).includes(String(c))) : [];
  return { adapter: d.adapter, tool: d.tool, args: d.args, preview: d.preview, classes };
}

function untrustedIn(texts: readonly string[]): string | undefined {
  const haystack = texts.join("\n").toLowerCase();
  return UNTRUSTED_STRINGS.find((marker) => haystack.includes(marker.toLowerCase()));
}

/** The floors the dispatch wrapper applied, re-applied to the row as stored: the row is data a file holds. */
function floorsOf(call: BoundDetails, ctx: AutoReviewPolicyContext): AutoReviewPolicyVerdict | undefined {
  const action = `${call.tool} ${typeof call.args === "string" ? call.args : JSON.stringify(call.args ?? {})}`;
  const subjects = subjectsOfAction(action);
  const hardline = hardlineBlock(subjects, ctx.hardline);
  if (hardline !== null) return refuse("hardline", `hardline rule ${hardline.id}: ${hardline.reason}`);
  for (const subject of subjects) {
    if (subject.kind !== "command") continue;
    const floor = floorBlock(subject.value);
    if (floor !== null) return refuse("approval_floor", `approval floor: ${floor}`);
  }
  const deny = (ctx.deny ?? []).length > 0 ? denyMatch(ctx.deny ?? [], subjects.map((s) => s.value), ctx.hardline.home) : null;
  if (deny !== null) return refuse("deny_glob", `approvals.deny glob ${deny.glob} matched`);
  return undefined;
}

function moneyOf(call: BoundDetails, policy: AutoReviewConfig): AutoReviewPolicyVerdict | number {
  const amount = amountCentsOf(call.args);
  if (amount === undefined) return refuse("money_amount_unknown", "a money call whose total in integer cents cannot be read from its arguments");
  const currency = typeof (call.args as { currency?: unknown }).currency === "string" ? String((call.args as { currency: string }).currency).trim().toLowerCase() : "";
  if (currency !== policy.currency) return refuse("money_currency", `the call is in ${currency === "" ? "no stated currency" : currency}, the cap is in ${policy.currency}`);
  if (amount > policy.max_amount_cents) return refuse("money_over_cap", `${amount} cents is over max_amount_cents ${policy.max_amount_cents} (${policy.currency})`);
  return amount;
}

export function evaluateAutoReviewPolicy(row: ApprovalRow, policy: AutoReviewConfig, ctx: AutoReviewPolicyContext): AutoReviewPolicyVerdict {
  if (!policy.enabled) return refuse("disabled", "governance.auto_review.enabled is false");
  const call = boundDetailsOf(row);
  if (call === undefined) return refuse("not_bound_call", "only a call bound to its exact arguments is reviewed; this row is left for a human");
  if (row.status !== "pending") return refuse("not_pending", `the row is already ${row.status}`);

  const marker = untrustedIn([call.preview, row.action, typeof call.args === "string" ? call.args : JSON.stringify(call.args ?? null)]);
  if (marker !== undefined) return refuse("untrusted_provenance", `the call carries ${marker}: it is derived from text written outside this machine`);

  const floored = floorsOf(call, ctx);
  if (floored !== undefined) return floored;

  const classes = [...new Set<PolicyClass>([...call.classes, ...classifyCall({ adapter: call.adapter, scopes: [], tool: call.tool === call.adapter ? "" : call.tool, args: call.args })])];
  if (classes.length === 0) return refuse("unclassified", "no class could be read off the call");
  const tier = tierOfClasses(classes);
  const never = classes.filter((cls) => NEVER_AUTO_CLASSES.includes(cls));
  if (tier === "never") return refuse("never_class", `the call is ${never.join(" and ")}, which no policy lets a reviewer approve`);
  if (AUTO_REVIEW_TIERS.indexOf(tier) > AUTO_REVIEW_TIERS.indexOf(policy.max_class)) {
    return refuse("class_above_max", `the call is ${tier} (${classes.join(", ")}), above max_class ${policy.max_class}`);
  }

  let amountCents: number | undefined;
  if (classes.includes("money_moving")) {
    const money = moneyOf(call, policy);
    if (typeof money !== "number") return money;
    amountCents = money;
  }

  const recipients = recipientsOf(call.args);
  if (classes.some((cls) => SENDING_CLASSES.includes(cls))) {
    if (recipients.length === 0) return refuse("recipient_unknown", "a send whose arguments name no recipient the allowlist could be checked against");
    const outside = recipients.filter((recipient) => !recipientAllowed(recipient, policy.recipients));
    if (outside.length > 0) return refuse("recipient_not_allowed", `${outside.join(", ")} ${outside.length === 1 ? "is" : "are"} not on governance.auto_review.recipients`);
  }

  // [C3] A send or a payment is a person's, whatever max_class says.
  if (!isApprovableTier(tier)) return refuse("send_or_money", `the call is ${tier} (${classes.join(", ")}): ${ASKS_YOU_FIRST}, whatever max_class says`);

  return { eligible: true, tier, classes, recipients, ...(amountCents === undefined ? {} : { amountCents }) };
}
