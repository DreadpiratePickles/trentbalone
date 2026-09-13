/**
 * Approvals over chat, enforced server-side.
 *
 * A button in Telegram, Discord or Slack, or an `APPROVE <id> <nonce>` email reply, is a
 * VIEW. The decision resolves against the durable approval row: the id must be pending,
 * the nonce must match the row, and the sender must be a paired admin in that scope. A
 * replayed or forged callback fails all three checks and changes nothing.
 */

import crypto from "node:crypto";
import EventEmitter from "node:events";
import type { ApprovalRow, GatewayStore } from "./store/GatewayStore.js";
import { MemoryGatewayStore } from "./store/GatewayStore.js";
import { PairingManager } from "./security/PairingManager.js";
import type { StorePort } from "../store/StorePort.js";
import type { OutboundButton, Scope } from "./transport/types.js";

export type ApprovalRequest = ApprovalRow;

export interface ApprovalBridgeOptions {
  store?: GatewayStore;
  pairing?: PairingManager;
  /** When present, approval rows are mirrored into the orchestration store as well. */
  storePort?: StorePort;
  companyId?: string;
}

export interface CallbackInput {
  platform: string;
  senderId: string;
  scope: Scope;
  channelId: string;
  /** The button id / callback data exactly as received: `trent:<approve|deny>:<id>:<nonce>`. */
  data: string;
}

export type CallbackResult =
  | { ok: true; approval: ApprovalRow; decision: "approved" | "denied" }
  | { ok: false; reason: "malformed" | "no_matching_pending_approval" | "not_admin" };

const CALLBACK_RE = /^trent:(approve|deny):([A-Za-z0-9_-]{1,40}):([a-f0-9]{8})$/;
const EMAIL_RE = /^\s*(APPROVE|DENY)\s+([A-Za-z0-9_-]{1,40})\s+([a-f0-9]{8})\s*$/im;

export class ApprovalBridge extends EventEmitter {
  private readonly store: GatewayStore;
  private readonly pairing: PairingManager;
  private readonly storePort?: StorePort;
  private readonly companyId: string;

  constructor(options: ApprovalBridgeOptions = {}) {
    super();
    this.store = options.store ?? new MemoryGatewayStore();
    this.pairing = options.pairing ?? new PairingManager(this.store);
    this.storePort = options.storePort;
    this.companyId = options.companyId ?? "standalone";
  }

  public createApprovalRequest(
    agentId: string,
    action: string,
    details: Record<string, unknown>,
    options?: { budgetImpact?: number; estimatedDurationMs?: number },
  ): ApprovalRequest {
    const id = `appr_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`;
    const row: ApprovalRow = {
      id,
      nonce: crypto.randomBytes(4).toString("hex"),
      agentId,
      action,
      details,
      budgetImpact: options?.budgetImpact,
      estimatedDurationMs: options?.estimatedDurationMs,
      status: "pending",
      createdAt: new Date().toISOString(),
      deliveredTo: [],
    };
    this.store.mutate((s) => {
      s.approvals[id] = row;
    });
    void this.storePort
      ?.createApproval({ id, companyId: this.companyId, action, reason: JSON.stringify(details) })
      .catch(() => undefined);
    this.emit("approval_requested", row);
    return row;
  }

  public getApproval(id: string): ApprovalRequest | undefined {
    return this.store.snapshot().approvals[id];
  }

  public listPending(): ApprovalRequest[] {
    return Object.values(this.store.snapshot().approvals).filter((a) => a.status === "pending");
  }

  public recordDelivery(id: string, platform: string, channelId: string, messageId: string): void {
    this.store.mutate((s) => {
      const row = s.approvals[id];
      if (row) (row.deliveredTo ??= []).push({ platform, channelId, messageId });
    });
  }

  /** Local (TUI/CLI) decision path. Chat decisions go through `resolveCallback`. */
  public decide(id: string, decision: "approved" | "denied", decidedBy = "user"): ApprovalRequest {
    const row = this.store.mutate((s) => {
      const r = s.approvals[id];
      if (!r) throw new Error(`Approval request "${id}" not found.`);
      if (r.status !== "pending") throw new Error(`Approval request "${id}" is already ${r.status}.`);
      r.status = decision;
      r.decidedAt = new Date().toISOString();
      r.decidedBy = decidedBy;
      return structuredClone(r);
    });
    void this.storePort
      ?.resolveApproval(id, decision === "approved" ? "approved" : "rejected")
      .catch(() => undefined);
    this.emit("approval_decided", row);
    return row;
  }

  /** The one entry point for every chat-originated decision. */
  public resolveCallback(input: CallbackInput): CallbackResult {
    const m = CALLBACK_RE.exec(input.data);
    if (!m) return { ok: false, reason: "malformed" };
    const [, verb, id, nonce] = m;
    const row = this.getApproval(id);
    if (!row || row.status !== "pending" || !timingSafeEqual(row.nonce, nonce)) {
      return { ok: false, reason: "no_matching_pending_approval" };
    }
    if (!this.pairing.isAdmin(input.platform, input.senderId, input.scope)) {
      return { ok: false, reason: "not_admin" };
    }
    const decision = verb === "approve" ? "approved" : "denied";
    const approval = this.decide(id, decision, `${input.platform}:${input.senderId}`);
    return { ok: true, approval, decision };
  }

  public parseEmailReply(body: string): { decision: "approve" | "deny"; id: string; nonce: string } | null {
    const m = EMAIL_RE.exec(body);
    if (!m) return null;
    return { decision: m[1].toLowerCase() as "approve" | "deny", id: m[2], nonce: m[3] };
  }

  public callbackData(request: ApprovalRequest, verb: "approve" | "deny"): string {
    return `trent:${verb}:${request.id}:${request.nonce}`;
  }

  public buttons(request: ApprovalRequest): OutboundButton[][] {
    return [
      [
        { id: this.callbackData(request, "approve"), label: "Approve", style: "primary" },
        { id: this.callbackData(request, "deny"), label: "Deny", style: "danger" },
      ],
    ];
  }

  public cardText(request: ApprovalRequest): string {
    const lines = [
      "APPROVAL REQUIRED",
      `Agent: ${request.agentId}`,
      `Action: ${request.action}`,
      `Details: ${JSON.stringify(request.details)}`,
    ];
    if (request.budgetImpact !== undefined) lines.push(`Budget impact: $${request.budgetImpact.toFixed(2)}`);
    lines.push(`Ref: ${request.id}`);
    return lines.join("\n");
  }

  /** Email has no buttons: the reply body carries the decision. */
  public emailCardText(request: ApprovalRequest): string {
    return [
      this.cardText(request),
      "",
      `Reply with exactly one line: APPROVE ${request.id} ${request.nonce}`,
      `or: DENY ${request.id} ${request.nonce}`,
    ].join("\n");
  }

  public formatTelegramCard(request: ApprovalRequest): {
    text: string;
    inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
  } {
    return {
      text: this.cardText(request),
      inline_keyboard: this.buttons(request).map((row) => row.map((b) => ({ text: b.label, callback_data: b.id }))),
    };
  }

  public formatSlackCard(request: ApprovalRequest): Record<string, unknown> {
    return {
      text: this.cardText(request),
      blocks: [
        { type: "section", text: { type: "mrkdwn", text: this.cardText(request) } },
        {
          type: "actions",
          block_id: `trent_approval_${request.id}`,
          elements: this.buttons(request)[0].map((b) => ({
            type: "button",
            text: { type: "plain_text", text: b.label },
            style: b.style === "default" ? undefined : b.style,
            action_id: b.id,
            value: b.id,
          })),
        },
      ],
    };
  }
}

function timingSafeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}
