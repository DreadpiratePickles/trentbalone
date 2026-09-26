/**
 * [H1] The auto reviewer over held calls (gap 10). Claude's auto mode has a second model review each
 * action and blocks anything with no verdict; Codex's auto-review changes WHO reviews at the sandbox
 * edge, not what is allowed. Here: a held bound-call row, inside the written policy, is put to a
 * reviewer model with its exact preview, its bound arguments and the policy; approve and deny go
 * through the same `ApprovalBridge.decide` a human's `trent approvals approve` uses, with the
 * reviewer as the actor; escalate, a malformed reply or no reply leaves the row for the human. Every
 * decision lands on the approvals audit chain. Every model here is a fake: no call leaves the process.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ApprovalBridge } from "../gateway/ApprovalBridge.js";
import { FileGatewayStore, type ApprovalRow } from "../gateway/store/GatewayStore.js";
import type { GatewayCompletion, GatewayStreamRequest } from "../model-gateway/types.js";
import type { SpendCharge } from "./spend-ledger.js";
import { approvalAuditPath, readApprovalAudit, verifyApprovalAudit } from "./auto-review-audit.js";
import { AutoReviewConfigSchema, autoReviewGrantUsedAt, type AutoReviewConfig } from "./auto-review-config.js"; // [C3] AutoReviewConfig
import { autoReviewOf, overrideAutoReview, parseReviewVerdict, reviewHeldApprovals, type AutoReviewDeps, type ReviewGateway } from "./auto-review.js";
import { createBoundApprovalStore, type BoundApprovalStore, type BoundCall } from "./bound-approvals.js";

let home: string;
let profileDir: string;
let store: FileGatewayStore;
let bindings: BoundApprovalStore;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "trent-auto-review-"));
  profileDir = path.join(home, ".trent");
  fs.mkdirSync(profileDir, { recursive: true });
  store = new FileGatewayStore(path.join(profileDir, "gateway.json"));
  bindings = createBoundApprovalStore({ store });
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

const MODEL = "qwen3.5:9b";
const ACTOR = `auto-review:${MODEL}`;
// [C3] A reviewer decides only read and write calls (README.md:11-13), so the call these tests park is a
// write an owner put on the class floor (`gate.ask_classes: [write]`). The SMS is what it must never be asked about.
const ARGS = { path: "notes/opening-hours.md", content: "Open until 10pm on Fridays." };
const CALL: BoundCall = { adapter: "file_ops", action: `write_file ${JSON.stringify(ARGS)}`, tool: "write_file", args: ARGS, seat: "support", classes: ["write"] };
const PREVIEW = "Write notes/opening-hours.md: Open until 10pm on Fridays.";
const SMS_ARGS = { to: "+15550100", from: "+15550000", body: "Your table is booked for 7pm tonight." };
const SMS: BoundCall = { adapter: "business", action: `sms_send ${JSON.stringify(SMS_ARGS)}`, tool: "sms_send", args: SMS_ARGS, seat: "support", classes: ["external_send", "customer_facing"] };
const SMS_PREVIEW = "SMS from +15550000 to +15550100: Your table is booked for 7pm tonight.";
const POLICY = AutoReviewConfigSchema.parse({ enabled: true, model: MODEL, max_class: "write" });
// [/C3]

const APPROVE = JSON.stringify({ decision: "approve", reason: "a booking confirmation to an allowlisted number" });
const DENY = JSON.stringify({ decision: "deny", reason: "the text promises a time the preview does not show" });
const ESCALATE = JSON.stringify({ decision: "escalate", reason: "unsure whether the customer asked for this" });

function completion(text: string, model: string): GatewayCompletion {
  return { text, provider: "openai", model, modelTier: "haiku", inputTokens: 120, outputTokens: 24, costCents: 3, estimated: false, priced_as_default: false, finishReason: "stop" };
}

interface FakeGateway {
  readonly requests: GatewayStreamRequest[];
  built(): number;
  readonly factory: () => Promise<ReviewGateway>;
}

function fakeGateway(reply: string | Error): FakeGateway {
  const requests: GatewayStreamRequest[] = [];
  let built = 0;
  const gateway: ReviewGateway = {
    async complete(req) {
      requests.push(req);
      if (reply instanceof Error) throw reply;
      return completion(reply, MODEL);
    },
  };
  return {
    requests,
    built: () => built,
    factory: async () => {
      built += 1;
      return gateway;
    },
  };
}

function deps(fake: FakeGateway, overrides: Partial<AutoReviewDeps> = {}): AutoReviewDeps {
  return { store, profileDir, policy: POLICY, hardline: { home, profileDir }, gateway: fake.factory, ...overrides };
}

/** Parks the call out of a seat turn, exactly as the class floor does, and returns the row id. */
function park(call: BoundCall = CALL, preview = PREVIEW): string { // [C3] CALL, and the SMS's own preview
  const decision = bindings.require(call, preview);
  expect(decision.granted).toBe(false);
  return decision.row!.id;
}

function rowOf(id: string): ApprovalRow {
  const row = store.snapshot().approvals[id];
  expect(row).toBeDefined();
  return row!;
}

describe("the reviewer's verdict is strict JSON", () => {
  it("accepts exactly {decision, reason}, with a code fence or a leading think block stripped", () => {
    expect(parseReviewVerdict(APPROVE)).toEqual({ ok: true, verdict: { decision: "approve", reason: "a booking confirmation to an allowlisted number" } });
    expect(parseReviewVerdict("```json\n" + DENY + "\n```").ok).toBe(true);
    expect(parseReviewVerdict(`<think>the number is on the list</think>\n${ESCALATE}`).ok).toBe(true);
  });

  it.each([
    ["prose", "Sure, approve it."],
    ["an unknown decision", JSON.stringify({ decision: "yes", reason: "fine" })],
    ["no reason", JSON.stringify({ decision: "approve" })],
    ["an empty reason", JSON.stringify({ decision: "approve", reason: "  " })],
    ["an extra key", JSON.stringify({ decision: "approve", reason: "fine", confidence: 0.9 })],
    ["two objects", `${APPROVE}\n${DENY}`],
    ["an array", "[]"],
  ])("refuses %s", (_label, text) => {
    expect(parseReviewVerdict(text).ok).toBe(false);
  });
});

describe("reviewHeldApprovals", () => {
  it("approves within policy through the bridge a human approve uses, with the reviewer as the actor and one audit row", async () => {
    const id = park();
    const bridge = new ApprovalBridge({ store });
    const decided: ApprovalRow[] = [];
    bridge.on("approval_decided", (row: ApprovalRow) => decided.push(row));
    const fake = fakeGateway(APPROVE);

    const result = await reviewHeldApprovals(deps(fake, { bridge }));

    expect(result.enabled).toBe(true);
    expect(result.outcomes).toEqual([expect.objectContaining({ id, decision: "approve", actor: ACTOR, status: "approved", modelCalled: true })]);
    // Only `ApprovalBridge.decide` emits this event: the same code path `trent approvals approve` takes.
    expect(decided.map((row) => [row.id, row.status, row.decidedBy])).toEqual([[id, "approved", ACTOR]]);
    const row = rowOf(id);
    expect(row).toMatchObject({ status: "approved", decidedBy: ACTOR });
    expect(row.decidedAt).toBeTruthy();
    expect(autoReviewOf(row)).toMatchObject({ decision: "approve", actor: ACTOR, reason: "a booking confirmation to an allowlisted number" });

    // The reviewer is pinned, deterministic, and shown the exact preview, the bound arguments and the policy.
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]).toMatchObject({ model: MODEL, temperature: 0 });
    const prompt = fake.requests[0]!.messages.map((m) => m.content).join("\n");
    expect(prompt).toContain(PREVIEW);
    expect(prompt).toContain(JSON.stringify(ARGS));
    expect(prompt).toContain('"max_class":"write"'); // [C3]

    const audit = readApprovalAudit(profileDir);
    expect(audit).toEqual([expect.objectContaining({ actor: ACTOR, action: "approval.approved", objectType: "approval", objectId: id })]);
    expect(verifyApprovalAudit(profileDir).failures).toEqual([]);

    // The identical call now runs, and only now is the grant marked as used.
    expect(autoReviewGrantUsedAt(rowOf(id))).toBeUndefined();
    expect(bindings.require(CALL, PREVIEW).granted).toBe(true); // [C3] CALL
    expect(autoReviewGrantUsedAt(rowOf(id))).toBeTruthy();
  });

  it("denies with the reason, and the call is then blocked naming the reviewer", async () => {
    const id = park();

    const result = await reviewHeldApprovals(deps(fakeGateway(DENY)));

    expect(result.outcomes).toEqual([expect.objectContaining({ id, decision: "deny", status: "denied", actor: ACTOR })]);
    expect(rowOf(id)).toMatchObject({ status: "denied", decidedBy: ACTOR });
    const blocked = bindings.require(CALL, PREVIEW); // [C3] CALL
    expect(blocked.granted).toBe(false);
    if (!blocked.granted) {
      expect(blocked.record.status).toBe("blocked");
      expect(blocked.record.summary).toContain(ACTOR);
    }
    const [entry] = readApprovalAudit(profileDir);
    expect(entry).toMatchObject({ actor: ACTOR, action: "approval.denied", objectId: id });
    expect(entry!.summary).toContain("the text promises a time the preview does not show");
  });

  it("escalate leaves the row pending for the human, recorded on the row and on the chain", async () => {
    const id = park();

    const result = await reviewHeldApprovals(deps(fakeGateway(ESCALATE)));

    expect(result.outcomes).toEqual([expect.objectContaining({ id, decision: "escalate", status: "pending" })]);
    expect(rowOf(id).status).toBe("pending");
    expect(rowOf(id).decidedBy).toBeUndefined();
    expect(autoReviewOf(rowOf(id))).toMatchObject({ decision: "escalate", actor: ACTOR });
    expect(bindings.require(CALL, PREVIEW).granted).toBe(false); // [C3] CALL
    expect(readApprovalAudit(profileDir)).toEqual([expect.objectContaining({ action: "approval.escalated", objectId: id })]);
  });

  it.each([
    ["prose", "Looks fine to me, approve."],
    ["a verdict outside the enum", JSON.stringify({ decision: "allow", reason: "fine" })],
    ["a verdict with no reason", JSON.stringify({ decision: "approve" })],
  ])("treats %s as no verdict: the row stays blocked for the human", async (_label, reply) => {
    const id = park();

    const result = await reviewHeldApprovals(deps(fakeGateway(reply)));

    expect(result.outcomes).toEqual([expect.objectContaining({ id, decision: "escalate", status: "pending", modelCalled: true })]);
    expect(rowOf(id).status).toBe("pending");
    expect(bindings.require(CALL, PREVIEW).granted).toBe(false); // [C3] CALL
    const [entry] = readApprovalAudit(profileDir);
    expect(entry).toMatchObject({ action: "approval.escalated", objectId: id });
    expect(entry!.summary).toContain("no verdict");
  });

  it("an absent verdict (the reviewer call fails) blocks, is audited, and leaves the row unmarked so the next pass asks again", async () => {
    const id = park();

    const failed = await reviewHeldApprovals(deps(fakeGateway(new Error("connect ECONNREFUSED 127.0.0.1:11434"))));

    expect(failed.outcomes).toEqual([expect.objectContaining({ id, decision: "escalate", status: "pending" })]);
    expect(autoReviewOf(rowOf(id))).toBeUndefined();
    expect(readApprovalAudit(profileDir)[0]?.summary).toContain("no verdict");

    const retried = await reviewHeldApprovals(deps(fakeGateway(APPROVE)));
    expect(retried.outcomes).toEqual([expect.objectContaining({ id, decision: "approve" })]);
    expect(verifyApprovalAudit(profileDir).failures).toEqual([]);
  });

  it("escalates a call outside the policy with the rule named, and never builds or calls a model for it", async () => {
    const id = park(SMS, SMS_PREVIEW); // [C3] an SMS is above every ceiling a config may hold
    const fake = fakeGateway(APPROVE);

    const result = await reviewHeldApprovals(deps(fake));

    expect(fake.built()).toBe(0);
    expect(result.outcomes).toEqual([expect.objectContaining({ id, decision: "escalate", actor: "auto-review:policy", rule: "class_above_max", modelCalled: false })]);
    expect(rowOf(id).status).toBe("pending");
    expect(autoReviewOf(rowOf(id))).toMatchObject({ decision: "escalate", rule: "class_above_max" });
    expect(readApprovalAudit(profileDir)).toEqual([expect.objectContaining({ actor: "auto-review:policy", action: "approval.escalated" })]);
  });

  // [C3] README.md:11-13: a send or a payment asks you first at every autonomy level, so no model decides one.
  it("[C3] never puts a send or a payment to the model, even under a stale config whose max_class reaches it", async () => {
    const sms = park(SMS, SMS_PREVIEW);
    const linkArgs = { currency: "usd", items: [{ description: "deposit", amount_cents: 2500 }] };
    const link: BoundCall = { adapter: "business", action: `stripe_payment_link_create ${JSON.stringify(linkArgs)}`, tool: "stripe_payment_link_create", args: linkArgs, seat: "support", classes: ["money_moving"] };
    const payment = bindings.require(link, "Payment link: deposit, 25.00 USD").row!.id;
    const stale: AutoReviewConfig = { ...AutoReviewConfigSchema.parse({ enabled: true, model: MODEL, max_amount_cents: 5000, recipients: ["+15550100"] }), max_class: "money" };
    const fake = fakeGateway(APPROVE);

    const result = await reviewHeldApprovals(deps(fake, { policy: stale }));

    expect(fake.built()).toBe(0);
    expect(fake.requests).toEqual([]);
    for (const id of [sms, payment]) {
      expect(result.outcomes).toContainEqual(expect.objectContaining({ id, decision: "escalate", actor: "auto-review:policy", rule: "send_or_money", modelCalled: false, status: "pending" }));
      expect(rowOf(id).status).toBe("pending");
    }
    expect(bindings.require(SMS, SMS_PREVIEW).granted).toBe(false);
  });

  it("reviews a row once: a second pass asks no model about it", async () => {
    park();
    const fake = fakeGateway(ESCALATE);
    await reviewHeldApprovals(deps(fake));
    const second = await reviewHeldApprovals(deps(fake));
    expect(fake.requests).toHaveLength(1);
    expect(second.outcomes).toEqual([]);
  });

  it("never touches a run approval: it is released the instant it is decided and has no bound arguments", async () => {
    const bridge = new ApprovalBridge({ store });
    const step = bridge.createApprovalRequest("marketing", "publish the launch post", { runId: "run-1", stepId: "step-1", reason: null }, { runId: "run-1", stepId: "step-1" });
    const before = rowOf(step.id);
    const fake = fakeGateway(APPROVE);

    const result = await reviewHeldApprovals(deps(fake, { bridge }));

    expect(result.outcomes).toEqual([]);
    expect(fake.built()).toBe(0);
    expect(rowOf(step.id)).toEqual(before);
  });

  it("charges the reviewer's own spend to the ledger the daily cap reads", async () => {
    park();
    const charges: SpendCharge[] = [];
    await reviewHeldApprovals(deps(fakeGateway(APPROVE), { spend: { append: (charge) => void charges.push(charge) } }));
    expect(charges).toEqual([expect.objectContaining({ surface: "auto-review", model: MODEL, cents: 3, tokens: 144 })]);
  });
});

describe("with governance.auto_review disabled nothing changes", () => {
  it("reads no model, writes no row and creates no audit file", async () => {
    park();
    const before = fs.readFileSync(path.join(profileDir, "gateway.json"));
    const fake = fakeGateway(APPROVE);

    const result = await reviewHeldApprovals(deps(fake, { policy: AutoReviewConfigSchema.parse({}) }));

    expect(result).toEqual({ enabled: false, outcomes: [] });
    expect(fake.built()).toBe(0);
    expect(fs.readFileSync(path.join(profileDir, "gateway.json")).equals(before)).toBe(true);
    expect(fs.existsSync(approvalAuditPath(profileDir))).toBe(false);
  });

  it("leaves a human approval and its replay exactly as before: no review record, no grant stamp", async () => {
    const id = park();
    new ApprovalBridge({ store }).decide(id, "approved", "human");
    expect(bindings.require(CALL, PREVIEW).granted).toBe(true); // [C3] CALL
    const row = rowOf(id);
    expect(Object.keys(row.details).sort()).toEqual(["adapter", "args", "classes", "key", "kind", "preview", "tool"]);
    expect(fs.existsSync(approvalAuditPath(profileDir))).toBe(false);
  });
});

describe("a human over the reviewer", () => {
  it("reverses an auto-approved call that has not run: the replay is blocked and the reversal is on the chain", async () => {
    const id = park();
    await reviewHeldApprovals(deps(fakeGateway(APPROVE)));

    const reversed = overrideAutoReview({ store, profileDir, id, decision: "denied", by: "human" });

    expect(reversed).toMatchObject({ ok: true, row: { status: "denied", decidedBy: "human" } });
    expect(autoReviewOf(rowOf(id))).toMatchObject({ decision: "approve", overriddenBy: "human" });
    expect(bindings.require(CALL, PREVIEW).granted).toBe(false); // [C3] CALL
    expect(readApprovalAudit(profileDir).map((row) => [row.action, row.actor])).toEqual([
      ["approval.approved", ACTOR],
      ["approval.reversed", "human"],
    ]);
    expect(verifyApprovalAudit(profileDir).failures).toEqual([]);
  });

  it("refuses to reverse a call that already ran", async () => {
    const id = park();
    await reviewHeldApprovals(deps(fakeGateway(APPROVE)));
    expect(bindings.require(CALL, PREVIEW).granted).toBe(true); // [C3] CALL

    const refused = overrideAutoReview({ store, profileDir, id, decision: "denied", by: "human" });

    expect(refused).toMatchObject({ ok: false, reason: "already_ran" });
    expect(rowOf(id).status).toBe("approved");
  });

  it("may approve what the reviewer denied, and the call then runs", async () => {
    const id = park();
    await reviewHeldApprovals(deps(fakeGateway(DENY)));

    expect(overrideAutoReview({ store, profileDir, id, decision: "approved", by: "human" })).toMatchObject({ ok: true, row: { status: "approved", decidedBy: "human" } });
    expect(bindings.require(CALL, PREVIEW).granted).toBe(true); // [C3] CALL
  });

  it("does not treat a human's own decision as the reviewer's", () => {
    const id = park();
    new ApprovalBridge({ store }).decide(id, "approved", "human");
    expect(overrideAutoReview({ store, profileDir, id, decision: "denied", by: "human" })).toMatchObject({ ok: false, reason: "not_auto_reviewed" });
  });
});
