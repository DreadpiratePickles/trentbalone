import { describe, it, expect, beforeEach } from "vitest";
import { ApprovalBridge, type ApprovalRequest } from "./ApprovalBridge.js";
import { MemoryGatewayStore } from "./store/GatewayStore.js";
import { PairingManager } from "./security/PairingManager.js";
import type { InboundReaction } from "./transport/types.js";

const THUMBS_UP = "\u{1F44D}";
const THUMBS_DOWN = "\u{1F44E}";
const CHECK_MARK = "✅";
const CROSS_MARK = "❌";

describe("ApprovalBridge.resolveReaction", () => {
  let bridge: ApprovalBridge;
  let pairing: PairingManager;
  let request: ApprovalRequest;

  const reaction = (overrides: Partial<InboundReaction> = {}): InboundReaction => ({
    platform: "telegram",
    channelId: "555",
    messageId: "900",
    emoji: THUMBS_UP,
    senderId: "555",
    scope: "dm",
    ...overrides,
  });

  beforeEach(() => {
    const store = new MemoryGatewayStore();
    pairing = new PairingManager(store);
    bridge = new ApprovalBridge({ store, pairing });
    pairing.grant({ platform: "telegram", senderId: "555", scope: "dm", tier: "admin" });
    pairing.grant({ platform: "telegram", senderId: "666", scope: "dm", tier: "regular" });
    request = bridge.createApprovalRequest("ceo", "Deploy to production", { sha: "abc" });
    bridge.recordDelivery(request.id, "telegram", "555", "900");
  });

  it("a thumbs-up from a paired admin on the delivered card approves it once, and records who decided", () => {
    const decided: ApprovalRequest[] = [];
    bridge.on("approval_decided", (row: ApprovalRequest) => decided.push(row));
    const result = bridge.resolveReaction(reaction());
    expect(result).toEqual({ ok: true, decision: "approved", approval: expect.objectContaining({ id: request.id, status: "approved", decidedBy: "telegram:555" }) });
    expect(decided.map((r) => r.id)).toEqual([request.id]);
  });

  it("a second reaction on an already decided card changes nothing", () => {
    expect(bridge.resolveReaction(reaction()).ok).toBe(true);
    const again = bridge.resolveReaction(reaction({ emoji: THUMBS_DOWN }));
    expect(again).toEqual({ ok: false, reason: "no_matching_pending_approval" });
    expect(bridge.getApproval(request.id)?.status).toBe("approved");
  });

  it("a reaction from an unpaired or non-admin sender is rejected and leaves the row pending", () => {
    expect(bridge.resolveReaction(reaction({ senderId: "666" }))).toEqual({ ok: false, reason: "not_admin" });
    expect(bridge.resolveReaction(reaction({ senderId: "stranger" }))).toEqual({ ok: false, reason: "not_admin" });
    expect(bridge.getApproval(request.id)?.status).toBe("pending");
  });

  it("a reaction on a message that is not a delivered card, or in another channel or platform, is ignored", () => {
    expect(bridge.resolveReaction(reaction({ messageId: "901" }))).toEqual({ ok: false, reason: "no_matching_pending_approval" });
    expect(bridge.resolveReaction(reaction({ channelId: "777" }))).toEqual({ ok: false, reason: "no_matching_pending_approval" });
    expect(bridge.resolveReaction(reaction({ platform: "slack" }))).toEqual({ ok: false, reason: "no_matching_pending_approval" });
    expect(bridge.getApproval(request.id)?.status).toBe("pending");
  });

  it("thumbs-down or a cross mark denies; a check mark approves", () => {
    expect(bridge.resolveReaction(reaction({ emoji: THUMBS_DOWN }))).toEqual(expect.objectContaining({ ok: true, decision: "denied" }));
    expect(bridge.getApproval(request.id)?.status).toBe("denied");

    const second = bridge.createApprovalRequest("ceo", "Refund", {});
    bridge.recordDelivery(second.id, "telegram", "555", "901");
    expect(bridge.resolveReaction(reaction({ messageId: "901", emoji: CROSS_MARK }))).toEqual(expect.objectContaining({ ok: true, decision: "denied" }));

    const third = bridge.createApprovalRequest("ceo", "Ship", {});
    bridge.recordDelivery(third.id, "telegram", "555", "902");
    expect(bridge.resolveReaction(reaction({ messageId: "902", emoji: CHECK_MARK }))).toEqual(expect.objectContaining({ ok: true, decision: "approved" }));
  });

  it("accepts Slack reaction names and skin-tone or variation-selector suffixes, and ignores every other emoji", () => {
    const slack = bridge.createApprovalRequest("ceo", "Rotate keys", {});
    bridge.recordDelivery(slack.id, "slack", "C1", "1700000000.000100");
    pairing.grant({ platform: "slack", senderId: "U1", scope: "group", tier: "admin" });
    const slackReaction = (emoji: string) => reaction({ platform: "slack", channelId: "C1", messageId: "1700000000.000100", senderId: "U1", scope: "group", emoji });
    expect(bridge.resolveReaction(slackReaction("eyes"))).toEqual({ ok: false, reason: "unknown_emoji" });
    expect(bridge.getApproval(slack.id)?.status).toBe("pending");
    expect(bridge.resolveReaction(slackReaction("+1::skin-tone-3"))).toEqual(expect.objectContaining({ ok: true, decision: "approved" }));

    const variant = bridge.createApprovalRequest("ceo", "Prune", {});
    bridge.recordDelivery(variant.id, "telegram", "555", "903");
    expect(bridge.resolveReaction(reaction({ messageId: "903", emoji: `${THUMBS_DOWN}\u{1F3FD}` }))).toEqual(expect.objectContaining({ ok: true, decision: "denied" }));
    const selector = bridge.createApprovalRequest("ceo", "Archive", {});
    bridge.recordDelivery(selector.id, "telegram", "555", "904");
    expect(bridge.resolveReaction(reaction({ messageId: "904", emoji: `${CROSS_MARK}️` }))).toEqual(expect.objectContaining({ ok: true, decision: "denied" }));
  });

  it("goes through the same nonce check as a button: a row whose nonce was tampered with cannot be decided by a reaction", () => {
    const store = new MemoryGatewayStore();
    const p = new PairingManager(store);
    const b = new ApprovalBridge({ store, pairing: p });
    p.grant({ platform: "discord", senderId: "U1", scope: "group", tier: "admin" });
    const req = b.createApprovalRequest("ceo", "Deploy", {});
    b.recordDelivery(req.id, "discord", "C1", "M100");
    store.mutate((s) => { s.approvals[req.id].status = "expired"; });
    expect(b.resolveReaction({ platform: "discord", channelId: "C1", messageId: "M100", emoji: THUMBS_UP, senderId: "U1", scope: "group" })).toEqual({ ok: false, reason: "no_matching_pending_approval" });
  });
});
