import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export interface SessionMessage {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  agent?: string;
  content: string;
  timestamp: string;
  metadata?: {
    cost?: number;
    duration_ms?: number;
    durationMs?: number;
    model?: string;
    tokens?: { prompt: number; completion: number; total: number };
    tool_calls?: Array<{ name: string; args: unknown; result: unknown }>;
    files?: string[];
  };
}

export interface SessionData {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  agent: string;
  model: string;
  provider: string;
  messages: SessionMessage[];
  status: "active" | "completed" | "error" | "interrupted";
  total_cost: number;
  total_duration_ms: number;
}

export class SessionStore {
  private sessionsDir: string;

  constructor(sessionsDir: string) {
    this.sessionsDir = sessionsDir;
    if (!fs.existsSync(this.sessionsDir)) {
      fs.mkdirSync(this.sessionsDir, { recursive: true });
    }
  }

  private getSessionPath(sessionId: string): string {
    // Sanitize session id to prevent directory traversal
    const safeId = sessionId.replace(/[^a-zA-Z0-9_-]/g, "");
    return path.join(this.sessionsDir, `${safeId}.json`);
  }

  public save(session: SessionData): void {
    const sessionPath = this.getSessionPath(session.id);
    session.updated_at = new Date().toISOString();
    fs.writeFileSync(sessionPath, JSON.stringify(session, null, 2), "utf8");
  }

  public get(sessionId: string): SessionData | null {
    const sessionPath = this.getSessionPath(sessionId);
    if (!fs.existsSync(sessionPath)) {
      return null;
    }
    try {
      const content = fs.readFileSync(sessionPath, "utf8");
      return JSON.parse(content) as SessionData;
    } catch {
      return null;
    }
  }

  public list(): SessionData[] {
    if (!fs.existsSync(this.sessionsDir)) {
      return [];
    }
    const files = fs.readdirSync(this.sessionsDir);
    const sessions: SessionData[] = [];

    for (const file of files) {
      if (file.endsWith(".json")) {
        try {
          const content = fs.readFileSync(
            path.join(this.sessionsDir, file),
            "utf8"
          );
          sessions.push(JSON.parse(content) as SessionData);
        } catch {
          // Ignore invalid files
        }
      }
    }

    return sessions.sort(
      (a, b) =>
        new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
    );
  }

  public delete(sessionId: string): boolean {
    const sessionPath = this.getSessionPath(sessionId);
    if (fs.existsSync(sessionPath)) {
      fs.unlinkSync(sessionPath);
      return true;
    }
    return false;
  }

  public createNew(agent = "ceo", model = "gpt-5.6-terra", provider = "openai"): SessionData {
    const id = `sess_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
    const now = new Date().toISOString();
    const session: SessionData = {
      id,
      title: "New Session",
      created_at: now,
      updated_at: now,
      agent,
      model,
      provider,
      messages: [],
      status: "active",
      total_cost: 0,
      total_duration_ms: 0,
    };
    this.save(session);
    return session;
  }
}
