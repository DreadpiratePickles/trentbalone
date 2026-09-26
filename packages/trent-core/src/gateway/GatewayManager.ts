/**
 * The gateway core: one instance of every registered adapter, a default-deny pairing gate,
 * per-platform agent routing, a durable outbound queue with per-platform circuit breakers,
 * per-platform health, and chat approvals resolved against the durable approval row.
 *
 * No text is generated here. An inbound message that passes the gate is handed to the
 * `agentHandler` the CLI installs, which calls the real model gateway.
 */

import path from "node:path";
import { ConfigManager } from "../config/ConfigManager.js";
import { acquireProfileLock, acquireProfileWriter, gatewayRunningError } from "../profile/locks.js";
import type { StorePort } from "../store/StorePort.js";
import { ApprovalBridge, type ApprovalRequest } from "./ApprovalBridge.js";
import { BUSY_STATUS_LINE, ConversationQueue, INTERRUPT_REASON, type DoubleTextPolicy, type SubmitResult } from "./ConversationQueue.js";
import { PairingManager } from "./security/PairingManager.js";
import { MessageQueue, type MessageQueueOptions } from "./queue/MessageQueue.js";
import { FileGatewayStore, type ConversationAddress, type GatewayStore } from "./store/GatewayStore.js";
import { createAllAdapters, PLATFORM_REGISTRY } from "./registry.js";
import { prepareVoiceNote, type VoiceNoteOptions } from "./voice-notes.js";
import type {
  AdapterContext,
  ButtonCallback,
  CallbackAck,
  Capabilities,
  HealthStatus,
  InboundMessage,
  OutboundMessage,
  SendReceipt,
  TransportAdapter,
} from "./transport/types.js";
import type { BreakerSnapshot } from "./queue/CircuitBreaker.js";

/**
 * Receives a message that passed the gate; returns the agent's reply text, or null for silence.
 * `signal` aborts when the double-texting policy interrupts this turn or the sender says `/stop`.
 */
export type AgentHandler = (agentId: string, message: InboundMessage, signal?: AbortSignal) => Promise<string | null>;

// [S2] solo: a run whose stream ended at its gate is resumed here after a late decision
/**
 * Continues a run a LATE decision released, and says where its reply goes. A solo run's stream ends
 * at its gate (the handler's turn is over and the owner got a card); the owner decides later, on no
 * stream, so the runner announces the run id and the manager resumes it on the thread's own lane.
 * The CLI builds it over the runtime's runner (`apps/cli/src/gateway/agent-handler.ts`).
 */
export interface RunResumer {
  /** The thread a run was started from; undefined for a run that did not come from this gateway. */
  threadOf(runId: string): (ConversationAddress & { readonly subject?: string }) | undefined;
  /** Drives the resumed run to its end: its reply, or null for silence. */
  resume(runId: string, signal?: AbortSignal): Promise<string | null>;
  /** Tells the manager a run id when a decision lands on a run no reader is streaming. Returns the unsubscribe. */
  onLateDecision?(listener: (runId: string) => void): () => void;
  /** Announces the parked runs whose row was decided elsewhere (`trent approvals approve`); called on each drain tick. */
  sweep?(): unknown;
}
// [S2] end

export interface GatewayManagerOptions {
  store?: GatewayStore;
  storePort?: StorePort;
  agentHandler?: AgentHandler;
  adapterContext?: Partial<Omit<AdapterContext, "config" | "store">>;
  queue?: MessageQueueOptions;
  /** Milliseconds between queue drains once started. */
  drainIntervalMs?: number;
  /** Overrides `gateway.double_text_policy` from config. */
  doubleTextPolicy?: DoubleTextPolicy;
  /** [P2-3] The voice-note engine and its environment; defaults to the media toolset's local engines. */
  voiceNotes?: VoiceNoteOptions;
  /** [S2] Resumes a run a late decision released and posts its reply to the thread it came from. */
  resumer?: RunResumer;
}

export interface PlatformStatus {
  name: string;
  configured: boolean;
  designatedAgent: string;
  apiVersion: string;
  capabilities: Capabilities;
  breaker: BreakerSnapshot;
  pendingOutbound: number;
  health?: HealthStatus;
}

const DEFAULT_ROUTES: Record<string, string> = { telegram: "support", slack: "ceo", discord: "eng-ai-engineer" };
const DECISION_TEXT_RE = /^\s*trent:(approve|deny):[A-Za-z0-9_-]+:[a-f0-9]{8}\s*$/;

export class GatewayManager {
  private readonly configManager: ConfigManager;
  private readonly store: GatewayStore;
  private readonly approvalBridge: ApprovalBridge;
  private readonly pairing: PairingManager;
  private readonly queue: MessageQueue;
  private readonly conversations = new ConversationQueue();
  private readonly doubleTextPolicy: DoubleTextPolicy;
  private readonly adapters: Map<string, TransportAdapter>;
  private routes: Record<string, string> = {};
  private agentHandler?: AgentHandler;
  private drainTimer?: ReturnType<typeof setInterval>;
  private lastHealth = new Map<string, HealthStatus>();
  private readonly drainIntervalMs: number;
  private readonly voiceNotes: VoiceNoteOptions;
  /** Releases this profile's gateway lock and writer registration; set while started. */
  private releaseProfileLocks?: () => void;
  private resumer?: RunResumer; // [S2]
  private releaseResumer?: () => void; // [S2]

  constructor(configManager?: ConfigManager, options: GatewayManagerOptions = {}) {
    this.configManager = configManager ?? new ConfigManager();
    this.store = options.store ?? new FileGatewayStore(path.join(this.configManager.getProfileDir(), "gateway.json"));
    this.pairing = new PairingManager(this.store);
    this.approvalBridge = new ApprovalBridge({ store: this.store, pairing: this.pairing, storePort: options.storePort });
    this.agentHandler = options.agentHandler;
    this.drainIntervalMs = options.drainIntervalMs ?? 1000;
    this.voiceNotes = options.voiceNotes ?? {};
    this.doubleTextPolicy = options.doubleTextPolicy ?? this.configManager.loadConfig().gateway?.double_text_policy ?? "enqueue";
    const ctx: AdapterContext = { config: this.configManager, store: this.store, ...(options.adapterContext ?? {}) };
    this.adapters = createAllAdapters(ctx);
    for (const adapter of this.adapters.values()) {
      adapter.onMessage((m) => this.handleInbound(m));
      adapter.onCallback((c) => this.handleCallback(c));
      adapter.onReaction?.(async (r) => { this.approvalBridge.resolveReaction(r); });
    }
    this.queue = new MessageQueue(this.store, (platform, message) => this.transmit(platform, message), {
      ...(options.queue ?? {}),
      onSent: (row, receipt) => {
        options.queue?.onSent?.(row, receipt);
        const approvalId = row.message.metadata?.approvalId;
        if (typeof approvalId === "string") this.approvalBridge.recordDelivery(approvalId, row.platform, row.message.channelId, receipt.messageId);
      },
    });
    this.routes = { ...DEFAULT_ROUTES, ...(this.configManager.loadConfig().gateway?.routes ?? {}) };
    if (options.resumer) this.setResumer(options.resumer); // [S2]
  }

  // [S2] solo: resume after a late decision
  /** Installs (or replaces) the resumer and listens for its late decisions. */
  public setResumer(resumer: RunResumer): void {
    this.releaseResumer?.();
    this.resumer = resumer;
    this.releaseResumer = resumer.onLateDecision?.((runId) => void this.resumeRun(runId).catch(() => undefined));
  }

  /**
   * Resumes a run on the lane of the thread it came from, AFTER whatever turn that thread is running
   * (never interrupting it, whatever the double-texting policy), and sends the reply there. False when
   * no resumer knows the run, or the thread's lane was stopped.
   */
  public async resumeRun(runId: string): Promise<boolean> {
    const resumer = this.resumer;
    const thread = resumer?.threadOf(runId);
    if (resumer === undefined || thread === undefined) return false;
    const key = { platform: thread.platform, chatId: thread.channelId, ...(thread.threadId === undefined ? {} : { threadId: thread.threadId }) };
    let outcome: SubmitResult<string | null>;
    try {
      outcome = await this.conversations.submit(key, "", (signal) => resumer.resume(runId, signal), { policy: "enqueue" });
    } catch (err) {
      if (err instanceof Error && err.message === INTERRUPT_REASON) return false;
      throw err;
    }
    if (outcome.rejected || outcome.stopped) return false;
    if (outcome.value !== null && outcome.value !== "") {
      await this.send(thread.platform, { channelId: thread.channelId, threadId: thread.threadId, text: outcome.value, metadata: { subject: `Re: ${thread.subject ?? "Trent"}` } });
    }
    return true;
  }

  private sweepResumes(): void {
    try {
      this.resumer?.sweep?.();
    } catch {
      // A sweep that cannot read the rows costs a late resume, never the drain loop.
    }
  }
  // [S2] end

  // ------------------------------------------------------------------ accessors

  public getApprovalBridge(): ApprovalBridge { return this.approvalBridge; }
  public getPairing(): PairingManager { return this.pairing; }
  public getQueue(): MessageQueue { return this.queue; }
  public getConversationQueue(): ConversationQueue { return this.conversations; }
  public getDoubleTextPolicy(): DoubleTextPolicy { return this.doubleTextPolicy; }
  public getAdapter(platformId: string): TransportAdapter | undefined { return this.adapters.get(platformId); }
  public setAgentHandler(handler: AgentHandler): void { this.agentHandler = handler; }

  public getAgentForPlatform(platformId: string): string {
    return this.routes[platformId] ?? this.configManager.loadConfig().fleet?.default_agent ?? "ceo";
  }

  public setRoute(platformId: string, agentId: string): void {
    if (!PLATFORM_REGISTRY[platformId]) throw new Error(`Unknown platform "${platformId}"`);
    this.routes[platformId] = agentId;
    const config = this.configManager.loadConfig();
    config.gateway = { ...(config.gateway ?? { enabled: true, platforms: [] }), routes: { ...(config.gateway?.routes ?? {}), [platformId]: agentId } };
    this.configManager.saveConfig(config);
  }

  public capabilityMatrix(): Record<string, Capabilities> {
    const out: Record<string, Capabilities> = {};
    for (const [id, a] of this.adapters) out[id] = a.capabilities();
    return out;
  }

  public getStatus(): Record<string, PlatformStatus> {
    const result: Record<string, PlatformStatus> = {};
    for (const [id, adapter] of this.adapters) {
      result[id] = {
        name: adapter.name,
        configured: adapter.isConfigured(),
        designatedAgent: this.getAgentForPlatform(id),
        apiVersion: adapter.apiVersion,
        capabilities: adapter.capabilities(),
        breaker: this.queue.breakerSnapshot(id),
        pendingOutbound: this.queue.pending(id).length,
        health: this.lastHealth.get(id),
      };
    }
    return result;
  }

  public async healthAll(): Promise<Record<string, HealthStatus>> {
    const out: Record<string, HealthStatus> = {};
    await Promise.all([...this.adapters].map(async ([id, a]) => {
      const h = await a.health();
      this.lastHealth.set(id, h);
      out[id] = h;
    }));
    return out;
  }

  // ------------------------------------------------------------------ lifecycle

  /**
   * One gateway per profile (`profile/locks.ts`): the profile's gateway lock is taken before any
   * adapter starts, so a second start on the same profile throws `EXIT.CONFIG` naming the first
   * one's pid and attaches nothing, instead of answering every chat message a second time. A start
   * on another profile is unaffected. The gateway is also a live writer on the profile, so the
   * maintenance commands refuse while it runs. `stopAll` releases both.
   */
  public async startAllConfigured(): Promise<string[]> {
    this.holdProfileLocks();
    const started: string[] = [];
    for (const [id, adapter] of this.adapters) {
      if (!adapter.isConfigured()) continue;
      try {
        await adapter.start();
        started.push(id);
      } catch (err) {
        this.lastHealth.set(id, { platform: id, state: "down", checkedAt: new Date().toISOString(), detail: err instanceof Error ? err.message : String(err) });
      }
    }
    if (!this.drainTimer) {
      this.drainTimer = setInterval(() => { void this.queue.drain(); this.sweepResumes(); }, this.drainIntervalMs); // [S2] sweep
      this.drainTimer.unref?.();
    }
    void this.queue.drain();
    this.sweepResumes(); // [S2] rows decided while this gateway was down
    return started;
  }

  public async stopAll(): Promise<void> {
    clearInterval(this.drainTimer);
    this.drainTimer = undefined;
    this.releaseResumer?.(); // [S2] a decision after this belongs to no gateway of this process
    this.releaseResumer = undefined;
    for (const adapter of this.adapters.values()) await adapter.stop().catch(() => undefined);
    // Last: the lock says a gateway is attached until its adapters have let go.
    const release = this.releaseProfileLocks;
    this.releaseProfileLocks = undefined;
    release?.();
  }

  private holdProfileLocks(): void {
    if (this.releaseProfileLocks !== undefined) return;
    const profileDir = this.configManager.getProfileDir();
    const lock = acquireProfileLock({ profileDir, role: "gateway", label: "gateway" });
    if (!lock.ok) throw gatewayRunningError("gateway.start", lock.holder, lock.path);
    const releaseWriter = acquireProfileWriter(profileDir, "gateway");
    this.releaseProfileLocks = () => {
      releaseWriter();
      lock.release();
    };
  }

  // ------------------------------------------------------------------ outbound

  private async transmit(platform: string, message: OutboundMessage): Promise<SendReceipt> {
    const adapter = this.adapters.get(platform);
    if (!adapter) throw new Error(`Unknown platform "${platform}"`);
    return adapter.send(message);
  }

  /** Persists the message, then attempts delivery immediately. Never throws on delivery failure. */
  public async send(platform: string, message: OutboundMessage): Promise<{ queued: string; sent: boolean }> {
    const row = this.queue.enqueue(platform, message);
    const result = await this.queue.drain();
    return { queued: row.id, sent: result.sent > 0 && this.queue.pending(platform).every((r) => r.id !== row.id) };
  }

  /**
   * Renders an approval card for the platform and queues it; where it lands is recorded on the
   * approval row. The title follows the kind — an approval asks for a decision, an `ask_human`
   * card asks the founder a question — while the callback, the nonce and the delivery record are
   * the same either way, so reactions and decisions resolve exactly as before.
   */
  public async sendApproval(request: ApprovalRequest, platform: string, channelId: string, threadId?: string): Promise<{ queued: string; sent: boolean }> {
    const adapter = this.adapters.get(platform);
    if (!adapter) throw new Error(`Unknown platform "${platform}"`);
    const buttons = adapter.capabilities().buttons;
    const text = buttons ? this.approvalBridge.cardText(request) : this.approvalBridge.emailCardText(request);
    // The approval id rides on the queued row, so the delivery is recorded when the row is actually sent,
    // from whichever process drains it, and a reaction on that message can find the card.
    return this.send(platform, { channelId, threadId, text, buttons: buttons ? this.approvalBridge.buttons(request) : undefined, metadata: { subject: this.approvalBridge.cardSubject(request), approvalId: request.id } });
  }

  // ------------------------------------------------------------------ inbound

  public async handleInbound(message: InboundMessage): Promise<void> {
    const decision = this.pairing.authorize({ platform: message.platform, senderId: message.senderId, scope: message.scope, channelId: message.channelId });
    if (!decision.allowed) {
      if (decision.reason === "pairing_required" && decision.fresh) {
        await this.send(message.platform, {
          channelId: message.channelId,
          threadId: message.threadId,
          // [C7] names no command: the owner finds the code in `gateway pairings` and approves it there
          text: `Trent does not know you yet.\nPairing code: ${decision.code}\nThe owner can approve it; the code expires in one hour.`,
          metadata: { subject: "Trent pairing code" },
        });
      }
      return; // rate-limited, group-not-paired, or repeat: silence
    }

    // [P2-3] Only past the pairing gate is a voice note downloaded and transcribed; the run sees its text.
    const prepared = await prepareVoiceNote(message, this.configManager, this.voiceNotes);
    if (!prepared.ok) {
      await this.send(message.platform, { channelId: message.channelId, threadId: message.threadId, text: prepared.reply, metadata: { subject: "Re: Voice note" } });
      return;
    }
    message = prepared.message;

    // A text reply carrying a decision (email, Signal, Teams, Home Assistant) is a callback.
    const asDecision = this.decisionFromText(message.content);
    if (asDecision) {
      const ack = await this.handleCallback({ platform: message.platform, callbackId: message.id, senderId: message.senderId, channelId: message.channelId, scope: message.scope, actionId: asDecision });
      await this.send(message.platform, { channelId: message.channelId, threadId: message.threadId, text: ack.text, metadata: { subject: "Re: Approval" } });
      return;
    }

    // A free-text reply in a chat holding a pending ask_human question is its answer (ApprovalBridge.answerQuestion
    // checks the delivery record and the admin pairing); the agent never sees it.
    const answered = this.approvalBridge.answerQuestion({ platform: message.platform, senderId: message.senderId, scope: message.scope, channelId: message.channelId, text: message.content });
    if (answered.ok) {
      await this.send(message.platform, { channelId: message.channelId, threadId: message.threadId, text: `Answer recorded for ${answered.approval.id}; the run continues with it.`, metadata: { subject: "Re: Question" } });
      return;
    }

    if (!this.agentHandler) return;
    const handler = this.agentHandler;
    const agentId = this.getAgentForPlatform(message.platform);
    const subject = `Re: ${typeof message.metadata?.subject === "string" ? message.metadata.subject : "Trent"}`;
    const key = { platform: message.platform, chatId: message.channelId, threadId: message.threadId };
    let outcome: SubmitResult<string | null>;
    try {
      outcome = await this.conversations.submit(key, message.content, (signal) => handler(agentId, message, signal), { policy: this.doubleTextPolicy });
    } catch (err) {
      // An interrupted turn may reject with the abort; that is the policy working, not a failure.
      if (err instanceof Error && err.message === INTERRUPT_REASON) return;
      throw err;
    }
    if (outcome.rejected) {
      await this.send(message.platform, { channelId: message.channelId, threadId: message.threadId, text: BUSY_STATUS_LINE, metadata: { subject } });
      return;
    }
    if (outcome.stopped) return;
    const reply = outcome.value;
    if (reply !== null && reply !== "") {
      await this.send(message.platform, { channelId: message.channelId, threadId: message.threadId, text: reply, metadata: { subject } });
    }
  }

  private decisionFromText(content: string): string | null {
    if (DECISION_TEXT_RE.test(content)) return content.trim();
    const parsed = this.approvalBridge.parseEmailReply(content);
    return parsed ? `trent:${parsed.decision}:${parsed.id}:${parsed.nonce}` : null;
  }

  public async handleCallback(callback: ButtonCallback): Promise<CallbackAck> {
    const result = this.approvalBridge.resolveCallback({ platform: callback.platform, senderId: callback.senderId, scope: callback.scope, channelId: callback.channelId, data: callback.actionId });
    if (result.ok) return { ok: true, text: `${result.decision === "approved" ? "Approved" : "Denied"}: ${result.approval.action} (${result.approval.id})` };
    const text = result.reason === "not_admin" ? "You are not an approver on this platform." : result.reason === "malformed" ? "Unrecognised action." : "No matching pending approval.";
    return { ok: false, text };
  }
}
