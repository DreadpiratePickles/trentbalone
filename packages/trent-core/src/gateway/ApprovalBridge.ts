/**
 * Approvals over chat, enforced server-side.
 *
 * A button in Telegram, Discord or Slack, an `APPROVE <id> <nonce>` email reply, or a
 * thumbs-up on the delivered card, is a VIEW. The decision resolves against the durable
 * approval row: the id must be pending, the nonce must match the row, and the sender must
 * be a paired admin in that scope. A replayed or forged callback fails all three checks
 * and changes nothing. A reaction names no id or nonce; it is matched to the row through
 * the delivery record (platform, channel, message id) and then takes the same path.
 *
 * An `ask_human` question (`kind: "question"`) has no buttons: the founder answers with a
 * free-text reply in the chat the card was delivered to. The reply is matched to the pending
 * question row through the same delivery record, the sender must be a paired admin in that
 * scope, and the text becomes the row's `answer`; the row then resolves as `approved` and the
 * same `approval_decided` event carries it to the run link.
 */

import crypto from "node:crypto";
import EventEmitter from "node:events";
import type { ApprovalRow, GatewayStore } from "./store/GatewayStore.js";
import { MemoryGatewayStore } from "./store/GatewayStore.js";
import { PairingManager } from "./security/PairingManager.js";
import type { StorePort } from "../store/StorePort.js";
import type { InboundReaction, OutboundButton, Scope } from "./transport/types.js";

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

export type ReactionResult = CallbackResult | { ok: false; reason: "unknown_emoji" };

export interface AnswerInput {
  platform: string;
  senderId: string;
  scope: Scope;
  channelId: string;
  /** The reply text as received; whitespace-only is not an answer. */
  text: string;
}

export type AnswerResult =
  | { ok: true; approval: ApprovalRow }
  | { ok: false; reason: "no_matching_pending_question" | "not_admin" };

const CALLBACK_RE = /^trent:(approve|deny):([A-Za-z0-9_-]{1,40}):([a-f0-9]{8})$/;
const EMAIL_RE = /^\s*(APPROVE|DENY)\s+([A-Za-z0-9_-]{1,40})\s+([a-f0-9]{8})\s*$/im;

/**
 * Reactions that carry a decision, keyed by the platform identifier: Slack reaction names,
 * and the unicode emoji Discord and Telegram deliver (thumbs up U+1F44D, check mark U+2705,
 * thumbs down U+1F44E, cross mark U+274C). Anything else is not a decision.
 */
const REACTION_VERBS: Record<string, "approve" | "deny"> = {
  "+1": "approve",
  thumbsup: "approve",
  white_check_mark: "approve",
  heavy_check_mark: "approve",
  "\u{1F44D}": "approve",
  "\u2705": "approve",
  "-1": "deny",
  thumbsdown: "deny",
  x: "deny",
  "\u{1F44E}": "deny",
  "\u274C": "deny",
};
/** Slack skin-tone suffix (`+1::skin-tone-3`), Fitzpatrick modifiers U+1F3FB..U+1F3FF, variation selector U+FE0F. */
const EMOJI_MODIFIERS_RE = /::skin-tone-\d+$|[\u{1F3FB}-\u{1F3FF}\uFE0F]/gu;

export function reactionVerb(emoji: string): "approve" | "deny" | undefined {
  return REACTION_VERBS[emoji.replace(EMOJI_MODIFIERS_RE, "")];
}

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
    options?: { budgetImpact?: number; estimatedDurationMs?: number; runId?: string; stepId?: string; kind?: ApprovalRow["kind"] },
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
      runId: options?.runId,
      stepId: options?.stepId,
      ...(options?.kind === undefined ? {} : { kind: options.kind }),
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

  /**
   * A reaction on a delivered card. The card is found by where it was delivered, then the
   * decision is resolved exactly as a button press on that card would be, so the pending,
   * nonce and admin-pairing checks are the same code. Only a reaction that names a decision
   * counts; every other emoji is ignored.
   */
  public resolveReaction(reaction: InboundReaction): ReactionResult {
    const verb = reactionVerb(reaction.emoji);
    if (!verb) return { ok: false, reason: "unknown_emoji" };
    const row = this.listPending().find((r) =>
      (r.deliveredTo ?? []).some((d) => d.platform === reaction.platform && d.channelId === reaction.channelId && d.messageId === reaction.messageId),
    );
    if (!row) return { ok: false, reason: "no_matching_pending_approval" };
    return this.resolveCallback({
      platform: reaction.platform,
      senderId: reaction.senderId,
      scope: reaction.scope,
      channelId: reaction.channelId,
      data: this.callbackData(row, verb),
    });
  }

  /**
   * A free-text reply to a delivered question card. The pending question row is found by where it
   * was delivered (platform and channel), the sender must be a paired admin there, and the text
   * becomes the answer. An ordinary approval row is never answered by text.
   */
  public answerQuestion(input: AnswerInput): AnswerResult {
    const text = input.text.trim();
    if (text === "") return { ok: false, reason: "no_matching_pending_question" };
    const row = this.listPending().find((r) =>
      r.kind === "question" && (r.deliveredTo ?? []).some((d) => d.platform === input.platform && d.channelId === input.channelId),
    );
    if (!row) return { ok: false, reason: "no_matching_pending_question" };
    if (!this.pairing.isAdmin(input.platform, input.senderId, input.scope)) return { ok: false, reason: "not_admin" };
    this.store.mutate((s) => {
      const r = s.approvals[row.id];
      if (r) r.answer = text;
    });
    const approval = this.decide(row.id, "approved", `${input.platform}:${input.senderId}`);
    return { ok: true, approval };
  }

  public parseEmailReply(body: string): { decision: "approve" | "deny"; id: string; nonce: string } | null {
    const m = EMAIL_RE.exec(body);
    if (!m) return null;
    return { decision: m[1].toLowerCase() as "approve" | "deny", id: m[2], nonce: m[3] };
  }

  public callbackData(request: ApprovalRequest, verb: "approve" | "deny"): string {
    return `trent:${verb}:${request.id}:${request.nonce}`;
  }

  /** A question has no buttons: the reply is the answer. */
  public buttons(request: ApprovalRequest): OutboundButton[][] {
    if (request.kind === "question") return [];
    return [
      [
        { id: this.callbackData(request, "approve"), label: "Approve", style: "primary" },
        { id: this.callbackData(request, "deny"), label: "Deny", style: "danger" },
      ],
    ];
  }

  /**
   * The line a platform uses as the card's title (an email subject, a push notification). A
   * question from `ask_human` is not an approval: the founder is being asked something, and the
   * title says so rather than asking them to approve their own answer.
   */
  public cardSubject(request: ApprovalRequest): string {
    return request.kind === "question" ? `A question for you: ${request.action}` : `Approval needed: ${request.action}`;
  }

  // [C7] one plain line per action and the Ref; the row keeps its details for `trent approvals`
  public cardText(request: ApprovalRequest): string {
    if (request.kind === "question") return this.questionText(request);
    const lines = ["APPROVAL REQUIRED", this.actionLine(request)];
    if (request.budgetImpact !== undefined) lines.push(`Budget impact: $${request.budgetImpact.toFixed(2)}`);
    lines.push(`Ref: ${request.id}`);
    return lines.join("\n");
  }

  /** `<agent> wants to run <tool> on <target> for <amount>`, or `<agent> wants to: <action>`; at most 160 characters, never a brace. */
  private actionLine(request: ApprovalRequest): string {
    const { tool, args } = this.toolOf(request);
    const agent = this.plain(request.agentId);
    const target = this.targetOf(args);
    const amount = this.amountOf(args);
    const line =
      tool === undefined
        ? `${agent} wants to: ${this.plain(request.action) || "an unnamed action"}`
        : `${agent} wants to run ${this.plain(tool)}${target === undefined ? "" : ` on ${target}`}${amount === undefined ? "" : ` for ${amount}`}`;
    return line.length <= 160 ? line : `${line.slice(0, 157)}...`;
  }

  /**
   * A held call's `details.tool` and `args`; else an action written `<tool> <json>` (the MCP gate's rows)
   * or `<adapter> <tool> <json>` (a solo gate's step title, clipped at 120 characters, so its JSON may not
   * parse: the raw text is kept and the target is read off it).
   */
  private toolOf(request: ApprovalRequest): { tool?: string; args?: unknown } {
    const { tool, args } = request.details ?? {};
    if (typeof tool === "string" && tool !== "") return { tool, args };
    const written = /^(?:[\w.:-]+\s+)?([\w.:-]+)\s+(\{[\s\S]*)$/.exec(request.action.trim());
    if (written === null) return {};
    try {
      return { tool: written[1], args: JSON.parse(written[2]) as unknown };
    } catch {
      return { tool: written[1], args: written[2] };
    }
  }

  /** The first argument that names what the call reaches: a path, URL, recipient, channel, command. */
  private targetOf(args: unknown): string | undefined {
    if (typeof args !== "string" && (args === null || typeof args !== "object" || Array.isArray(args))) return undefined;
    for (const key of ["path", "file_path", "file", "url", "to", "recipient", "recipients", "email", "phone", "phone_number", "customer", "channel", "channel_id", "chat_id", "host", "command", "target", "name"]) {
      const value = typeof args === "string" ? new RegExp(`"${key}"\\s*:\\s*"([^"]*)"`).exec(args)?.[1] : (args as Record<string, unknown>)[key];
      const text = typeof value === "string" || typeof value === "number" ? String(value) : Array.isArray(value) ? value.filter((v) => typeof v === "string").slice(0, 3).join(", ") : "";
      if (this.plain(text) !== "") return this.plain(text);
    }
    return undefined;
  }

  /** A money call's total from integer cents (`items` x `quantity`, `expected_total_cents`, `amount_cents`), in dollars and cents. */
  private amountOf(args: unknown): string | undefined {
    if (args === null || typeof args !== "object" || Array.isArray(args)) return undefined;
    const bag = args as Record<string, unknown>;
    const isCents = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 0;
    let cents: number | undefined;
    if (Array.isArray(bag.items)) {
      const lines = bag.items.map((item) => (item !== null && typeof item === "object" ? (item as Record<string, unknown>) : {}));
      const valid = lines.length > 0 && lines.every((l) => isCents(l.amount_cents) && (l.quantity === undefined || isCents(l.quantity)));
      cents = valid ? lines.reduce((sum, l) => sum + (l.amount_cents as number) * ((l.quantity as number | undefined) ?? 1), 0) : undefined;
    } else {
      cents = [bag.expected_total_cents, bag.amount_cents].find(isCents);
    }
    if (cents === undefined) return undefined;
    const value = `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
    const currency = typeof bag.currency === "string" && bag.currency !== "" ? bag.currency.toUpperCase() : "USD";
    return currency === "USD" ? `$${value}` : `${value} ${this.plain(currency)}`;
  }

  /** One line of plain text: braces dropped, whitespace collapsed. */
  private plain(text: string): string {
    return text.replace(/[{}]/g, " ").replace(/\s+/g, " ").trim();
  }
  // [C7] end

  private questionText(request: ApprovalRequest): string {
    const details = request.details as { question?: unknown; context?: unknown; options?: unknown };
    const options = Array.isArray(details.options) ? details.options.filter((o): o is string => typeof o === "string") : [];
    return [
      `QUESTION FROM ${request.agentId}`,
      typeof details.question === "string" ? details.question : request.action,
      ...(typeof details.context === "string" && details.context !== "" ? ["", details.context] : []),
      ...(options.length ? ["", ...options.map((option, i) => `${i + 1}. ${option}`)] : []),
      "",
      "Reply to this message with your answer; the run continues with your reply as the answer.",
      `Ref: ${request.id}`,
    ].join("\n");
  }

  /** Email has no buttons: the reply body carries the decision. */
  public emailCardText(request: ApprovalRequest): string {
    if (request.kind === "question") return this.questionText(request);
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
