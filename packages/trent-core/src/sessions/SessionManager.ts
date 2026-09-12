import crypto from "node:crypto";
import {
  SessionStore,
  type PruneOptions,
  type PruneResult,
  type SessionData,
  type SessionMessage,
} from "./SessionStore.js";
import { centsToDollars, dollarsToCents } from "./schema.js";
import { ConfigManager } from "../config/ConfigManager.js";

export class SessionManager {
  private store: SessionStore;
  private currentSession: SessionData | null = null;

  constructor(configManager?: ConfigManager) {
    const mgr = configManager || new ConfigManager();
    this.store = new SessionStore(mgr.getSessionsDir());
  }

  public getStore(): SessionStore {
    return this.store;
  }

  public getCurrentSession(): SessionData | null {
    return this.currentSession;
  }

  public setCurrentSession(session: SessionData | null): void {
    this.currentSession = session;
  }

  public startSession(
    agent = "ceo",
    model = "gpt-5.6-terra",
    provider = "openai",
    initialTitle?: string
  ): SessionData {
    const session = this.store.createNew(agent, model, provider);
    if (initialTitle) {
      session.title = initialTitle;
      this.store.save(session);
    }
    this.currentSession = session;
    return session;
  }

  public resumeLastSession(): SessionData | null {
    const sessions = this.store.list();
    if (sessions.length === 0) {
      return null;
    }
    const lastSession = sessions[0];
    this.currentSession = lastSession;
    return lastSession;
  }

  public getSession(sessionId: string): SessionData | null {
    const session = this.store.get(sessionId);
    if (session) {
      this.currentSession = session;
    }
    return session;
  }

  public listSessions(): SessionData[] {
    return this.store.list();
  }

  /**
   * Retention sweep. The session currently loaded in this manager is always exempt, so a resume in
   * progress cannot have its transcript pruned out from under it.
   */
  public pruneSessions(options: PruneOptions = {}): PruneResult {
    const activeSessionId = options.activeSessionId ?? this.currentSession?.id;
    return this.store.pruneSessions(
      activeSessionId === undefined ? options : { ...options, activeSessionId },
    );
  }

  public deleteSession(sessionId: string): boolean {
    if (this.currentSession?.id === sessionId) {
      this.currentSession = null;
    }
    return this.store.delete(sessionId);
  }

  public appendMessage(
    sessionId: string,
    message: Omit<SessionMessage, "id" | "timestamp">
  ): SessionMessage {
    const session = this.store.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    const newMessage: SessionMessage = {
      ...message,
      id: `msg_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`,
      timestamp: new Date().toISOString(),
    };

    session.messages.push(newMessage);

    // Cents are canonical. A caller may still hand us legacy float dollars; convert once, here.
    const messageCents =
      newMessage.metadata?.cost_cents ?? dollarsToCents(newMessage.metadata?.cost ?? 0);
    if (messageCents > 0) {
      if (newMessage.metadata !== undefined) {
        newMessage.metadata.cost_cents = messageCents;
        newMessage.metadata.cost = centsToDollars(messageCents);
      }
      session.total_cost_cents += messageCents;
    }
    if (newMessage.metadata?.duration_ms) {
      session.total_duration_ms += newMessage.metadata.duration_ms;
    }

    // Auto-generate title from first user message if title is default
    if (
      session.title === "New Session" &&
      newMessage.role === "user" &&
      newMessage.content.trim()
    ) {
      const summary = newMessage.content.trim().slice(0, 50);
      session.title = summary.length === 50 ? `${summary}...` : summary;
    }

    this.store.save(session);
    this.currentSession = session;
    return newMessage;
  }

  public updateTitle(sessionId: string, title: string): void {
    const session = this.store.get(sessionId);
    if (session) {
      session.title = title;
      this.store.save(session);
      if (this.currentSession?.id === sessionId) {
        this.currentSession.title = title;
      }
    }
  }

  public updateStatus(sessionId: string, status: SessionData["status"]): void {
    const session = this.store.get(sessionId);
    if (session) {
      session.status = status;
      this.store.save(session);
      if (this.currentSession?.id === sessionId) {
        this.currentSession.status = status;
      }
    }
  }
}
