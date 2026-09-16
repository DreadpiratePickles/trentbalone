/**
 * The link between a parked orchestrator step and a chat approval card. A gate event on the run's
 * bus becomes one approval row carrying the run and step ids, sent to the configured owner; the
 * owner's decision on that row releases the step through the orchestrator's `approve`/`reject`.
 * The bridge and the store are real; the bus, the manager and the orchestrator are fakes.
 */

import { describe, expect, it, vi } from "vitest";
import type { OrcEvent } from "../orchestrator/types.js";
import { ApprovalBridge, type ApprovalRequest } from "./ApprovalBridge.js";
import { linkRunApprovals } from "./RunApprovalLink.js";
import { PairingManager } from "./security/PairingManager.js";
import { MemoryGatewayStore } from "./store/GatewayStore.js";

const OWNER = { platform: "telegram", channelId: "555" };

function gate(kind: "run_awaiting_approval" | "step_awaiting_approval", runId = "run_1", stepId = "step_1"): OrcEvent {
  return {
    kind,
    runId,
    at: "2026-09-15T00:00:00.000Z",
    step: { id: stepId, title: "Publish the launch post", agentRole: "growth" },
    detail: "publishing is gated",
  };
}

function fixture(options: { owner?: { platform: string; channelId: string } } = { owner: OWNER }) {
  const owner = options.owner;
  const store = new MemoryGatewayStore();
  const pairing = new PairingManager(store);
  pairing.grant({ platform: "telegram", senderId: "555", scope: "dm", tier: "admin" });
  const bridge = new ApprovalBridge({ store, pairing });
  const sent: Array<{ request: ApprovalRequest; platform: string; channelId: string }> = [];
  const manager = {
    sendApproval: vi.fn(async (request: ApprovalRequest, platform: string, channelId: string) => {
      sent.push({ request, platform, channelId });
      return { queued: "q1", sent: true };
    }),
  };
  const orchestrator = { approve: vi.fn(async () => true), reject: vi.fn(async () => true), answer: vi.fn(async () => true) };
  const lines: string[] = [];
  const link = linkRunApprovals({ orchestrator, bridge, manager, owner, log: (line) => lines.push(line) });
  return { bridge, manager, orchestrator, sent, link, lines };
}

describe("linkRunApprovals", () => {
  it("a run_awaiting_approval gate sends the owner one card whose row carries runId and stepId", async () => {
    const f = fixture();
    f.link.sink(gate("run_awaiting_approval"));
    await Promise.resolve();

    expect(f.manager.sendApproval).toHaveBeenCalledTimes(1);
    const { request, platform, channelId } = f.sent[0]!;
    expect(platform).toBe("telegram");
    expect(channelId).toBe("555");
    expect(request.runId).toBe("run_1");
    expect(request.stepId).toBe("step_1");
    expect(request.agentId).toBe("growth");
    expect(request.action).toBe("Publish the launch post");
    expect(f.bridge.getApproval(request.id)?.runId).toBe("run_1");
  });

  it("the bus emits step_ and run_awaiting_approval for one gate: the second is not sent again", async () => {
    const f = fixture();
    f.link.sink(gate("step_awaiting_approval"));
    f.link.sink(gate("run_awaiting_approval"));
    await Promise.resolve();
    expect(f.manager.sendApproval).toHaveBeenCalledTimes(1);
  });

  it("an approve callback on the card releases the step exactly once", async () => {
    const f = fixture();
    f.link.sink(gate("run_awaiting_approval"));
    await Promise.resolve();
    const request = f.sent[0]!.request;

    const result = f.bridge.resolveCallback({
      platform: "telegram",
      senderId: "555",
      scope: "dm",
      channelId: "555",
      data: f.bridge.callbackData(request, "approve"),
    });
    expect(result.ok).toBe(true);
    await Promise.resolve();

    expect(f.orchestrator.approve).toHaveBeenCalledTimes(1);
    expect(f.orchestrator.approve).toHaveBeenCalledWith("run_1", "step_1");
    expect(f.orchestrator.reject).not.toHaveBeenCalled();
  });

  it("a deny callback rejects the step; a decision on a row without run ids touches nothing", async () => {
    const f = fixture();
    f.link.sink(gate("run_awaiting_approval", "run_2", "step_9"));
    await Promise.resolve();
    f.bridge.resolveCallback({ platform: "telegram", senderId: "555", scope: "dm", channelId: "555", data: f.bridge.callbackData(f.sent[0]!.request, "deny") });
    await Promise.resolve();
    expect(f.orchestrator.reject).toHaveBeenCalledWith("run_2", "step_9");

    const unlinked = f.bridge.createApprovalRequest("ceo", "unrelated", {});
    f.bridge.decide(unlinked.id, "approved");
    await Promise.resolve();
    expect(f.orchestrator.approve).not.toHaveBeenCalled();
  });

  it("after the gate is decided, the same step gating again is a new card", async () => {
    const f = fixture();
    f.link.sink(gate("run_awaiting_approval"));
    await Promise.resolve();
    f.bridge.decide(f.sent[0]!.request.id, "approved");
    await Promise.resolve();
    f.link.sink(gate("run_awaiting_approval"));
    await Promise.resolve();
    expect(f.manager.sendApproval).toHaveBeenCalledTimes(2);
  });

  it("close() stops listening: a later decision releases nothing", async () => {
    const f = fixture();
    f.link.sink(gate("run_awaiting_approval"));
    await Promise.resolve();
    f.link.close();
    f.bridge.decide(f.sent[0]!.request.id, "approved");
    await Promise.resolve();
    expect(f.orchestrator.approve).not.toHaveBeenCalled();
  });

  it("with no owner configured the link is inert and says so in one structured log line", async () => {
    const f = fixture({});
    expect(f.link.active).toBe(false);
    f.link.sink(gate("run_awaiting_approval"));
    await Promise.resolve();
    expect(f.manager.sendApproval).not.toHaveBeenCalled();
    expect(f.lines).toHaveLength(1);
    const record = JSON.parse(f.lines[0]!) as { event: string; level: string };
    expect(record.event).toBe("gateway.approval_link.disabled");
    expect(record.level).toBe("warn");
  });
});

describe("linkRunApprovals with an ask_human question", () => {
  const ASK = 'ask_human {"question":"Ship EU or US first?","context":"Both are ready.","options":["EU","US"]}';
  function questionGate(): OrcEvent {
    return {
      kind: "run_awaiting_approval",
      runId: "run_1",
      at: "2026-09-15T00:00:00.000Z",
      step: { id: "step_1", title: "Ask the founder", agentRole: "ceo", seatLoopState: { pendingToolCall: { name: "human", action: ASK } } } as OrcEvent["step"],
      detail: "Awaiting tool approval: Ask the founder",
    };
  }

  it("creates a question row carrying the question, runId and stepId, delivered to the owner without buttons", async () => {
    const f = fixture();
    f.link.sink(questionGate());
    await Promise.resolve();
    const { request, platform, channelId } = f.sent[0]!;
    expect([platform, channelId]).toEqual(["telegram", "555"]);
    expect(request.kind).toBe("question");
    expect(request.runId).toBe("run_1");
    expect(request.stepId).toBe("step_1");
    expect(request.action).toBe("Ship EU or US first?");
    expect(request.details).toEqual(expect.objectContaining({ kind: "question", question: "Ship EU or US first?", context: "Both are ready.", options: ["EU", "US"] }));
    expect(f.bridge.buttons(request)).toEqual([]);
  });

  it("the owner's reply answers the row and resumes the run with the text through orchestrator.answer, once", async () => {
    const f = fixture();
    f.link.sink(questionGate());
    await Promise.resolve();
    const request = f.sent[0]!.request;
    f.bridge.recordDelivery(request.id, "telegram", "555", "900");
    const result = f.bridge.answerQuestion({ platform: "telegram", senderId: "555", scope: "dm", channelId: "555", text: "EU first." });
    expect(result.ok).toBe(true);
    await Promise.resolve();
    expect(f.orchestrator.answer).toHaveBeenCalledTimes(1);
    expect(f.orchestrator.answer).toHaveBeenCalledWith("run_1", "step_1", "EU first.");
    expect(f.orchestrator.approve).not.toHaveBeenCalled();
    expect(f.orchestrator.reject).not.toHaveBeenCalled();
  });

  it("a reply from a sender who is not a paired admin leaves the row pending and the run parked", async () => {
    const f = fixture();
    f.link.sink(questionGate());
    await Promise.resolve();
    const request = f.sent[0]!.request;
    f.bridge.recordDelivery(request.id, "telegram", "555", "900");
    expect(f.bridge.answerQuestion({ platform: "telegram", senderId: "999", scope: "dm", channelId: "555", text: "EU first." })).toEqual({ ok: false, reason: "not_admin" });
    await Promise.resolve();
    expect(f.bridge.getApproval(request.id)?.status).toBe("pending");
    expect(f.orchestrator.answer).not.toHaveBeenCalled();
  });
});
