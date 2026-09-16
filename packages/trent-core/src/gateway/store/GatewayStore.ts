/**
 * Durable state the gateway owns: outbound queue rows, sender pairings, pairing codes,
 * approval rows and the conversation-to-session map (a chat thread is one session). The Prisma StorePort covers orchestration entities and only runs under
 * Bun, so the gateway keeps its own small file-backed store with atomic writes; a
 * `StorePort` can additionally be mirrored into for approvals (see ApprovalBridge).
 */

import fs from "node:fs";
import path from "node:path";
import { atomicWriteFileSync, NODE_IO } from "../../config/atomic-fs.js";
import type { OutboundMessage, Scope } from "../transport/types.js";

export type Tier = "admin" | "regular";

export interface PairingRow {
  platform: string;
  senderId: string;
  scope: Scope;
  tier: Tier;
  pairedAt: string;
}

export interface PairingCodeRow {
  code: string;
  platform: string;
  senderId: string;
  scope: Scope;
  channelId?: string;
  issuedAt: number;
  expiresAt: number;
}

export type QueueStatus = "pending" | "sent" | "dead";

export interface QueueRow {
  id: string;
  platform: string;
  message: OutboundMessage;
  status: QueueStatus;
  attempts: number;
  createdAt: number;
  nextAttemptAt: number;
  sentAt?: number;
  lastError?: string;
}

export interface ApprovalRow {
  id: string;
  nonce: string;
  agentId: string;
  action: string;
  details: Record<string, unknown>;
  budgetImpact?: number;
  estimatedDurationMs?: number;
  status: "pending" | "approved" | "denied" | "expired";
  createdAt: string;
  decidedAt?: string;
  decidedBy?: string;
  /** Where the card was delivered, so the decision can be echoed back. */
  deliveredTo?: Array<{ platform: string; channelId: string; messageId: string }>;
  /** The orchestrator run and step this row gates, when the request came off a run's bus. */
  runId?: string;
  stepId?: string;
  /** An `ask_human` question is answered by a free-text reply, not a button; absent means approval. */
  kind?: "approval" | "question";
  /** The reply text that answered a question row. */
  answer?: string;
}

export interface GatewayState {
  version: 1;
  pairings: PairingRow[];
  pairingCodes: PairingCodeRow[];
  queue: QueueRow[];
  approvals: Record<string, ApprovalRow>;
  /** Free-form per-platform cursors (Telegram update offset, IMAP UID, Slack ts, ...). */
  cursors: Record<string, string>;
  /** `platform:chatId:threadId` (see `conversationKey`) to the session id that thread runs in. */
  conversations: Record<string, string>;
}

export function emptyState(): GatewayState {
  return { version: 1, pairings: [], pairingCodes: [], queue: [], approvals: {}, cursors: {}, conversations: {} };
}

/** The address of a conversation: a thread is its own conversation; no thread is the chat root. */
export interface ConversationAddress {
  platform: string;
  channelId: string;
  threadId?: string;
}

export function conversationKey(address: ConversationAddress): string {
  return `${address.platform}:${address.channelId}:${address.threadId ?? "root"}`;
}

export function getConversationSession(store: GatewayStore, key: string): string | undefined {
  return store.snapshot().conversations[key];
}

export function setConversationSession(store: GatewayStore, key: string, sessionId: string): void {
  store.mutate((state) => {
    state.conversations[key] = sessionId;
  });
}

export function clearConversationSession(store: GatewayStore, key: string): void {
  store.mutate((state) => {
    delete state.conversations[key];
  });
}

export interface GatewayStore {
  snapshot(): GatewayState;
  /** Apply a mutation and persist it before returning. */
  mutate<T>(fn: (state: GatewayState) => T): T;
}

export class MemoryGatewayStore implements GatewayStore {
  private state: GatewayState = emptyState();

  snapshot(): GatewayState {
    return structuredClone(this.state);
  }

  mutate<T>(fn: (state: GatewayState) => T): T {
    const next = structuredClone(this.state);
    const result = fn(next);
    this.state = next;
    return result;
  }
}

/**
 * JSON file with write-then-rename semantics. Every mutation re-reads the file first so
 * two processes sharing one profile (CLI + TUI) do not clobber each other's rows.
 */
export class FileGatewayStore implements GatewayStore {
  constructor(private readonly filePath: string) {}

  private read(): GatewayState {
    if (!fs.existsSync(this.filePath)) return emptyState();
    const raw = fs.readFileSync(this.filePath, "utf8");
    if (raw.trim() === "") return emptyState();
    const parsed = JSON.parse(raw) as Partial<GatewayState>;
    return { ...emptyState(), ...parsed };
  }

  snapshot(): GatewayState {
    return this.read();
  }

  mutate<T>(fn: (state: GatewayState) => T): T {
    const state = this.read();
    const result = fn(state);
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    atomicWriteFileSync(NODE_IO, this.filePath, JSON.stringify(state, null, 2), 0o600);
    return result;
  }
}
