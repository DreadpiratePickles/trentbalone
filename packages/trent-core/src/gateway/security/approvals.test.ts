import { describe, it, expect } from "vitest";
import { ApprovalBridge } from "../ApprovalBridge.js";
import { MemoryGatewayStore } from "../store/GatewayStore.js";
import { PairingManager } from "./PairingManager.js";

function make() {
  const store = new MemoryGatewayStore();
  const pairing = new PairingManager(store);
  pairing.grant({ platform: "telegram", senderId: "admin1", scope: "dm", tier: "admin" });
  pairing.grant({ platform: "telegram", senderId: "plain1", scope: "dm", tier: "regular" });
  const bridge = new ApprovalBridge({ store, pairing });
  return { store, pairing, bridge };
}

describe("ApprovalBridge — the chat button is a view, the row is the authority", () => {
  it("creates a durable pending row with a CSPRNG nonce in the callback data", () => {
    const { bridge, store } = make();
    const req = bridge.createApprovalRequest("ceo", "deploy", { sha: "abc" }, { budgetImpact: 1 });
    expect(req.status).toBe("pending");
    expect(store.snapshot().approvals[req.id]).toBeDefined();
    const card = bridge.formatTelegramCard(req);
    const approve = card.inline_keyboard[0][0].callback_data;
    expect(approve).toBe(`trent:approve:${req.id}:${req.nonce}`);
    expect(Buffer.byteLength(approve)).toBeLessThanOrEqual(64); // Telegram callback_data limit
    expect(card.text).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
  });

  it("resolves a genuine callback from a paired admin against the row", () => {
    const { bridge } = make();
    const req = bridge.createApprovalRequest("ceo", "deploy", {});
    const result = bridge.resolveCallback({
      platform: "telegram", senderId: "admin1", scope: "dm", channelId: "c",
      data: `trent:approve:${req.id}:${req.nonce}`,
    });
    expect(result.ok).toBe(true);
    expect(bridge.getApproval(req.id)?.status).toBe("approved");
    expect(bridge.getApproval(req.id)?.decidedBy).toBe("telegram:admin1");
  });

  it("rejects a forged callback whose nonce does not match the pending row", () => {
    const { bridge } = make();
    const req = bridge.createApprovalRequest("ceo", "deploy", {});
    const forged = bridge.resolveCallback({
      platform: "telegram", senderId: "admin1", scope: "dm", channelId: "c",
      data: `trent:approve:${req.id}:deadbeef`,
    });
    expect(forged.ok).toBe(false);
    if (!forged.ok) expect(forged.reason).toBe("no_matching_pending_approval");
    expect(bridge.getApproval(req.id)?.status).toBe("pending");
  });

  it("rejects a replayed callback after the row is already decided", () => {
    const { bridge } = make();
    const req = bridge.createApprovalRequest("ceo", "deploy", {});
    const data = `trent:deny:${req.id}:${req.nonce}`;
    expect(bridge.resolveCallback({ platform: "telegram", senderId: "admin1", scope: "dm", channelId: "c", data }).ok).toBe(true);
    const replay = bridge.resolveCallback({ platform: "telegram", senderId: "admin1", scope: "dm", channelId: "c", data });
    expect(replay.ok).toBe(false);
    if (!replay.ok) expect(replay.reason).toBe("no_matching_pending_approval");
    expect(bridge.getApproval(req.id)?.status).toBe("denied");
  });

  it("rejects a callback for an unknown id and a malformed payload", () => {
    const { bridge } = make();
    const unknown = bridge.resolveCallback({ platform: "telegram", senderId: "admin1", scope: "dm", channelId: "c", data: "trent:approve:appr_nope:abcdef12" });
    expect(unknown.ok).toBe(false);
    const junk = bridge.resolveCallback({ platform: "telegram", senderId: "admin1", scope: "dm", channelId: "c", data: "hello" });
    expect(junk.ok).toBe(false);
    if (!junk.ok) expect(junk.reason).toBe("malformed");
  });

  it("rejects a genuine callback from a sender who is not a paired admin", () => {
    const { bridge } = make();
    const req = bridge.createApprovalRequest("ceo", "deploy", {});
    const data = `trent:approve:${req.id}:${req.nonce}`;
    const regular = bridge.resolveCallback({ platform: "telegram", senderId: "plain1", scope: "dm", channelId: "c", data });
    expect(regular.ok).toBe(false);
    if (!regular.ok) expect(regular.reason).toBe("not_admin");
    const stranger = bridge.resolveCallback({ platform: "telegram", senderId: "nobody", scope: "dm", channelId: "c", data });
    expect(stranger.ok).toBe(false);
    expect(bridge.getApproval(req.id)?.status).toBe("pending");
  });

  it("parses an email reply: APPROVE/DENY plus the approval id, nonce required", () => {
    const { bridge, pairing } = make();
    pairing.grant({ platform: "email", senderId: "ops@example.com", scope: "dm", tier: "admin" });
    const req = bridge.createApprovalRequest("ceo", "deploy", {});
    const body = `APPROVE ${req.id} ${req.nonce}\n\n> On Monday, Trent wrote:\n> approval required`;
    const parsed = bridge.parseEmailReply(body);
    expect(parsed).toEqual({ decision: "approve", id: req.id, nonce: req.nonce });
    const result = bridge.resolveCallback({ platform: "email", senderId: "ops@example.com", scope: "dm", channelId: "ops@example.com", data: `trent:approve:${req.id}:${req.nonce}` });
    expect(result.ok).toBe(true);
    expect(bridge.parseEmailReply("DENY appr_x")).toBeNull();
  });

  it("keeps the TUI-facing API: listPending, decide, events", () => {
    const { bridge } = make();
    const events: string[] = [];
    bridge.on("approval_requested", () => events.push("requested"));
    bridge.on("approval_decided", () => events.push("decided"));
    const req = bridge.createApprovalRequest("ceo", "x", {});
    expect(bridge.listPending()).toHaveLength(1);
    bridge.decide(req.id, "approved", "tui");
    expect(bridge.listPending()).toHaveLength(0);
    expect(events).toEqual(["requested", "decided"]);
    expect(() => bridge.decide(req.id, "denied")).toThrow(/already approved/);
  });
});
