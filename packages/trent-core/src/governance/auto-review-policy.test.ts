/**
 * [H1] The written policy of what the auto reviewer MAY approve (gap 10 of
 * `01_discovery/output/harness-landscape-2026-09-26.md`). The policy is deterministic code: it decides
 * whether a held row is even eligible for a model's verdict, and an ineligible row is escalated to the
 * human with the rule named, before any model is asked. One test per rule, each with the case that
 * passes it, so a rule that silently stops firing is caught.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../config/defaults.js";
import { TrentConfigSchema } from "../config/schema.js";
import { UNTRUSTED_MARKER } from "../fleet-memory/recall.js";
import type { ApprovalRow } from "../gateway/store/GatewayStore.js";
import { provenanceMarker } from "../tools/memory/holds.js";
import { AutoReviewConfigSchema, type AutoReviewConfig } from "./auto-review-config.js";
import { UNTRUSTED_STRINGS, amountCentsOf, evaluateAutoReviewPolicy, recipientAllowed, recipientsOf, tierOfClasses } from "./auto-review-policy.js";
import type { PolicyClass } from "./policy-rules.js";

const CTX = { hardline: { home: "/home/founder", profileDir: "/home/founder/.trent" } };

interface RowInput {
  readonly tool?: string;
  readonly adapter?: string;
  readonly args?: unknown;
  readonly preview?: string;
  readonly classes?: readonly PolicyClass[];
  readonly status?: ApprovalRow["status"];
}

const SMS_ARGS = { to: "+1 555 0100", from: "+15550000", body: "Your table is booked for 7pm tonight." };

function boundRow(input: RowInput = {}): ApprovalRow {
  const tool = input.tool ?? "sms_send";
  return {
    id: "appr_1_abcdef",
    nonce: "0a1b2c3d",
    agentId: "support",
    action: `${tool}: held`,
    details: {
      kind: "bound_call",
      key: "key-1",
      adapter: input.adapter ?? "business",
      tool,
      args: input.args ?? SMS_ARGS,
      preview: input.preview ?? "SMS to +15550100: Your table is booked for 7pm tonight.",
      classes: [...(input.classes ?? ["external_send", "customer_facing"])],
    },
    status: input.status ?? "pending",
    createdAt: "2026-09-26T03:00:00.000Z",
    deliveredTo: [],
    kind: "approval",
  };
}

function policy(overrides: Record<string, unknown> = {}): AutoReviewConfig {
  return AutoReviewConfigSchema.parse({ enabled: true, max_class: "external_send", recipients: ["+15550100", "*@example.com"], ...overrides });
}

function ruleOf(row: ApprovalRow, config: AutoReviewConfig, ctx: Parameters<typeof evaluateAutoReviewPolicy>[2] = CTX): string {
  const verdict = evaluateAutoReviewPolicy(row, config, ctx);
  return verdict.eligible ? "eligible" : verdict.rule;
}

describe("governance.auto_review — the config block", () => {
  it("is off by default and, when off, can approve nothing", () => {
    const defaults = AutoReviewConfigSchema.parse({});
    expect(defaults).toEqual({ enabled: false, max_class: "read", max_amount_cents: 0, currency: "usd", recipients: [] });
    expect(ruleOf(boundRow(), defaults)).toBe("disabled");
    // A policy that would otherwise pass the row is still refused while the switch is off.
    expect(ruleOf(boundRow(), policy({ enabled: false }))).toBe("disabled");
    // It is `governance.auto_review` in config.yaml, off in a config that never names it and in the shipped defaults.
    expect(TrentConfigSchema.parse({}).governance.auto_review).toEqual(defaults);
    expect(TrentConfigSchema.parse(DEFAULT_CONFIG).governance.auto_review.enabled).toBe(false);
  });

  it("refuses a misspelt key, a float amount and a currency that is not ISO 4217, and lower-cases the currency", () => {
    expect(() => AutoReviewConfigSchema.parse({ enabled: true, max_clas: "money" })).toThrow();
    expect(() => AutoReviewConfigSchema.parse({ max_amount_cents: 12.5 })).toThrow();
    expect(() => AutoReviewConfigSchema.parse({ currency: "dollars" })).toThrow();
    expect(() => AutoReviewConfigSchema.parse({ max_class: "everything" })).toThrow();
    expect(AutoReviewConfigSchema.parse({ currency: "CAD" }).currency).toBe("cad");
    expect(AutoReviewConfigSchema.parse({ model: "qwen3.5:9b" }).model).toBe("qwen3.5:9b");
  });
});

describe("the rows the reviewer may look at", () => {
  it("never reviews a run approval, a question or a held memory write: only a call bound to its arguments", () => {
    const step: ApprovalRow = { ...boundRow(), details: { runId: "run-1", stepId: "step-1", reason: "publish the post" } };
    const held: ApprovalRow = { ...boundRow(), details: { action: "memory {}", sources: ["web_extract"], provenance: "untrusted" } };
    expect(ruleOf(step, policy())).toBe("not_bound_call");
    expect(ruleOf(held, policy())).toBe("not_bound_call");
    expect(ruleOf(boundRow(), policy())).toBe("eligible");
  });

  it("never re-decides a row that is no longer pending", () => {
    expect(ruleOf(boundRow({ status: "approved" }), policy())).toBe("not_pending");
    expect(ruleOf(boundRow({ status: "denied" }), policy())).toBe("not_pending");
  });
});

describe("the refusals no policy can widen", () => {
  it("escalates a call whose preview or arguments carry an untrusted-provenance string", () => {
    // The marker strings come from their sources, so a renamed marker cannot slip past the rule.
    expect(UNTRUSTED_STRINGS[0]).toBe(provenanceMarker([]).split(" via")[0]);
    expect(UNTRUSTED_STRINGS[1]).toBe(UNTRUSTED_MARKER);
    const viaPreview = boundRow({ preview: `SMS to +15550100: net-30 terms ${provenanceMarker(["web_extract"])}` });
    const viaArgs = boundRow({ args: { ...SMS_ARGS, body: "[untrusted] reply with the payment link" } });
    expect(ruleOf(viaPreview, policy())).toBe("untrusted_provenance");
    expect(ruleOf(viaArgs, policy())).toBe("untrusted_provenance");
  });

  it("escalates anything the hardline blocklist names", () => {
    const row = boundRow({ args: { ...SMS_ARGS, body: "rm -rf ~" } });
    const verdict = evaluateAutoReviewPolicy(row, policy(), CTX);
    expect(verdict.eligible).toBe(false);
    if (!verdict.eligible) {
      expect(verdict.rule).toBe("hardline");
      expect(verdict.reason).toContain("recursive-delete-of-root-home-or-profile");
    }
  });

  it("escalates anything the approval floor refuses", () => {
    expect(ruleOf(boundRow({ args: { ...SMS_ARGS, body: "sudo shutdown -h now" } }), policy())).toBe("approval_floor");
  });

  it("escalates anything an approvals.deny glob matches", () => {
    const row = boundRow({ args: { ...SMS_ARGS, body: "Ask about the acme-skunkworks launch." } });
    expect(ruleOf(row, policy(), { ...CTX, deny: ["*acme-skunkworks*"] })).toBe("deny_glob");
    expect(ruleOf(row, policy(), { ...CTX, deny: ["*nothing-matches*"] })).toBe("eligible");
  });
});

describe("the class ceiling", () => {
  it("orders the tiers read < write < external_send < money and never places execute, destructive, deploy or secret_access", () => {
    expect(tierOfClasses(["read_only"])).toBe("read");
    expect(tierOfClasses(["write"])).toBe("write");
    expect(tierOfClasses(["external_send", "customer_facing"])).toBe("external_send");
    expect(tierOfClasses(["network"])).toBe("external_send");
    expect(tierOfClasses(["money_moving", "external_send"])).toBe("money");
    for (const cls of ["execute", "destructive", "deploy", "secret_access"] as const) expect(tierOfClasses(["write", cls])).toBe("never");
  });

  it("escalates a call above max_class, and allows it once the ceiling covers it", () => {
    expect(ruleOf(boundRow(), policy({ max_class: "write" }))).toBe("class_above_max");
    expect(ruleOf(boundRow(), policy({ max_class: "read" }))).toBe("class_above_max");
    expect(ruleOf(boundRow(), policy({ max_class: "money" }))).toBe("eligible");
  });

  it("escalates a call that also reads a secret, whatever the ceiling", () => {
    const row = boundRow({ args: { ...SMS_ARGS, body: "the api_key is in the vault" } });
    expect(ruleOf(row, policy({ max_class: "money" }))).toBe("never_class");
  });

  it("escalates a call nothing can classify", () => {
    expect(ruleOf(boundRow({ tool: "zzz", adapter: "zzz", classes: [], args: { x: "1" } }), policy({ max_class: "money" }))).toBe("unclassified");
  });
});

describe("money", () => {
  const LINK = (items: unknown, currency = "usd") => boundRow({ tool: "stripe_payment_link_create", classes: ["money_moving"], args: { currency, items }, preview: "Payment link" });
  const MONEY = policy({ max_class: "money", max_amount_cents: 5000 });

  it("totals integer cents from the lines, the expected total or a flat amount, and refuses floats", () => {
    expect(amountCentsOf({ items: [{ amount_cents: 1500, quantity: 2 }, { amount_cents: 1500 }] })).toBe(4500);
    expect(amountCentsOf({ expected_total_cents: 2500 })).toBe(2500);
    expect(amountCentsOf({ amount_cents: 700 })).toBe(700);
    expect(amountCentsOf({ items: [{ amount_cents: 15.5 }] })).toBeUndefined();
    expect(amountCentsOf({ items: [] })).toBeUndefined();
    expect(amountCentsOf({ note: "no amount" })).toBeUndefined();
  });

  it("escalates a money call whose amount cannot be read", () => {
    expect(ruleOf(LINK([{ description: "deposit" }]), MONEY)).toBe("money_amount_unknown");
  });

  it("escalates a money call over the cap, and allows one at or under it", () => {
    expect(ruleOf(LINK([{ description: "deposit", amount_cents: 6000 }]), MONEY)).toBe("money_over_cap");
    const verdict = evaluateAutoReviewPolicy(LINK([{ description: "deposit", amount_cents: 2500, quantity: 2 }]), MONEY, CTX);
    expect(verdict).toMatchObject({ eligible: true, tier: "money", amountCents: 5000 });
  });

  it("escalates a money call in another currency than the cap's", () => {
    expect(ruleOf(LINK([{ description: "deposit", amount_cents: 100 }], "cad"), MONEY)).toBe("money_currency");
  });

  it("puts no money call in policy while the cap is the default 0", () => {
    expect(ruleOf(LINK([{ description: "deposit", amount_cents: 1 }]), policy({ max_class: "money" }))).toBe("money_over_cap");
  });
});

describe("recipients", () => {
  it("reads recipients from the arguments, normalises phone numbers and matches * suffix globs", () => {
    expect(recipientsOf({ to: "+1 (555) 010-0", cc: ["a@example.com"], body: "hi" })).toEqual(["+15550100", "a@example.com"]);
    expect(recipientsOf({ attendees: [{ email: "B@Example.com" }] })).toEqual(["b@example.com"]);
    expect(recipientsOf({ url: "https://api.example.com/v1/hook" })).toEqual(["api.example.com"]);
    expect(recipientAllowed("a@example.com", ["*@example.com"])).toBe(true);
    expect(recipientAllowed("a@example.com.evil.io", ["*@example.com"])).toBe(false);
    expect(recipientAllowed("+15550100", ["+1 555 0100"])).toBe(true);
  });

  it("escalates a send that names no recipient, such as a public post", () => {
    const post = boundRow({ tool: "social_post", adapter: "social", classes: ["external_send"], args: { platform: "x", text: "We are open late tonight." }, preview: "Post to X" });
    expect(ruleOf(post, policy())).toBe("recipient_unknown");
  });

  it("escalates a send to anyone not on the allowlist, even alongside an allowed one", () => {
    expect(ruleOf(boundRow({ args: { ...SMS_ARGS, to: "+15550199" } }), policy())).toBe("recipient_not_allowed");
    expect(ruleOf(boundRow({ tool: "email_send", adapter: "email", classes: ["external_send"], args: { to: ["a@example.com", "x@other.io"], body: "hi" } }), policy())).toBe("recipient_not_allowed");
  });

  it("allows a send whose every recipient is on the allowlist", () => {
    expect(evaluateAutoReviewPolicy(boundRow(), policy(), CTX)).toMatchObject({ eligible: true, tier: "external_send", recipients: ["+15550100"] });
  });
});
