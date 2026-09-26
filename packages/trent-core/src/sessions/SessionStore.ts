/**
 * On-disk session transcripts.
 *
 * Transcripts are the single most sensitive artefact this tool writes: they contain every prompt a
 * user ever pasted, which in practice means API keys, customer records and private source. The
 * `.env` beside them is chmod 0600; before this module was hardened these files were 0644 with a
 * 0755 directory. Every write now goes through write-then-rename with mode 0600 re-asserted on the
 * target, so a pre-existing permissive file cannot survive a rewrite.
 *
 * The store never deletes data it cannot parse: a corrupt file is moved to `quarantine/` so a
 * listing keeps working and the bytes stay recoverable.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { atomicWriteFileSync, NODE_IO, type ConfigIO } from "../config/atomic-fs.js";
import {
  SESSION_SCHEMA_VERSION,
  centsToDollars,
  migrateSessionRecord,
  needsMigration,
  type SessionData,
  type SessionMessage,
  type SessionMessageMetadata,
  type SessionStatus,
} from "./schema.js";

export type {
  SessionData,
  SessionMessage,
  SessionMessageMetadata,
  SessionStatus,
} from "./schema.js";
// Cost helpers stay behind `./schema.js`: `setup/money.ts` exports the same two names with
// different semantics, and a barrel-level collision is a silent wrong-answer waiting to happen.
export {
  SESSION_SCHEMA_VERSION,
  migrateSessionRecord,
  needsMigration,
} from "./schema.js";

/** Owner-only. Anything wider and a transcript is readable by every process on a shared box. */
export const SESSION_FILE_MODE = 0o600;
export const SESSION_DIR_MODE = 0o700;

/** Keep a month of transcripts unless the caller says otherwise. */
export const DEFAULT_MAX_AGE_DAYS = 30;

export interface PruneOptions {
  maxAgeDays?: number;
  maxCount?: number;
  /** The session being resumed right now. Never pruned, whatever the bounds say. */
  activeSessionId?: string;
}

export interface PruneResult {
  removed: string[];
  kept: number;
}

export interface SaveOptions {
  /** Set false to persist an explicitly supplied `updated_at` (used by pruning tests and imports). */
  touch?: boolean;
}

export class SessionStore {
  private sessionsDir: string;
  private io: ConfigIO;

  constructor(sessionsDir: string, io: ConfigIO = NODE_IO) {
    this.sessionsDir = sessionsDir;
    this.io = io;
    this.ensureDir(this.sessionsDir);
  }

  private ensureDir(dir: string): void {
    if (!this.io.existsSync(dir)) {
      this.io.mkdirSync(dir, { recursive: true });
    }
    // mkdir honours the process umask, so 0700 has to be asserted separately, every time.
    try {
      this.io.chmodSync(dir, SESSION_DIR_MODE);
    } catch {
      // A directory we cannot chmod (network mount, Windows) still has to be usable.
    }
  }

  public getSessionsDir(): string {
    return this.sessionsDir;
  }

  public getQuarantineDir(): string {
    return path.join(this.sessionsDir, "quarantine");
  }

  /** Sanitised absolute path for a session id. Rejects directory traversal by construction. */
  public pathFor(sessionId: string): string {
    const safeId = sessionId.replace(/[^a-zA-Z0-9_-]/g, "");
    return path.join(this.sessionsDir, `${safeId}.json`);
  }

  private getSessionPath(sessionId: string): string {
    return this.pathFor(sessionId);
  }

  public save(session: SessionData, options: SaveOptions = {}): void {
    const sessionPath = this.getSessionPath(session.id);
    session.schemaVersion = SESSION_SCHEMA_VERSION;
    if (options.touch !== false) {
      session.updated_at = new Date().toISOString();
    }
    // Cents are canonical; the dollars field is a view and is recomputed, never accumulated.
    session.total_cost_cents = Math.round(session.total_cost_cents ?? 0);
    session.total_cost = centsToDollars(session.total_cost_cents);

    this.ensureDir(this.sessionsDir);
    atomicWriteFileSync(
      this.io,
      sessionPath,
      JSON.stringify(session, null, 2),
      SESSION_FILE_MODE,
    );
  }

  /**
   * Move an unparseable file aside. Never deleted: the operator may want to recover it, and a
   * silent unlink of a transcript is indistinguishable from data loss.
   */
  private quarantine(filePath: string, reason: string): void {
    try {
      this.ensureDir(this.getQuarantineDir());
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const target = path.join(
        this.getQuarantineDir(),
        `${path.basename(filePath)}.${stamp}.corrupt`,
      );
      this.io.renameSync(filePath, target);
      this.io.chmodSync(target, SESSION_FILE_MODE);
      const note = `${target}.reason.txt`;
      this.io.writeFileSync(note, `${reason}\n`, { encoding: "utf8", mode: SESSION_FILE_MODE });
    } catch {
      // Quarantine is best effort. A failure here must still not break a listing.
    }
  }

  /** Parse + migrate one file. Returns null and quarantines when the content is unusable. */
  private load(filePath: string): SessionData | null {
    let content: string;
    try {
      content = this.io.readFileSync(filePath, "utf8");
    } catch {
      return null;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (err) {
      this.quarantine(filePath, `unparseable JSON: ${(err as Error).message}`);
      return null;
    }

    try {
      const migrated = migrateSessionRecord(parsed);
      if (needsMigration(parsed)) {
        // One-way migration, written back hardened so the legacy 0644 file cannot linger.
        this.save(migrated, { touch: false });
      }
      return migrated;
    } catch (err) {
      this.quarantine(filePath, `not a session record: ${(err as Error).message}`);
      return null;
    }
  }

  public get(sessionId: string): SessionData | null {
    const sessionPath = this.getSessionPath(sessionId);
    if (!this.io.existsSync(sessionPath)) return null;
    return this.load(sessionPath);
  }

  public list(): SessionData[] {
    if (!this.io.existsSync(this.sessionsDir)) return [];

    let entries: fs.Dirent[];
    try {
      entries = this.io.readdirSync(this.sessionsDir, { withFileTypes: true });
    } catch {
      return [];
    }

    const sessions: SessionData[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const loaded = this.load(path.join(this.sessionsDir, entry.name));
      if (loaded !== null) sessions.push(loaded);
    }

    return sessions.sort(
      (a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
    );
  }

  public delete(sessionId: string): boolean {
    const sessionPath = this.getSessionPath(sessionId);
    if (!this.io.existsSync(sessionPath)) return false;
    this.io.unlinkSync(sessionPath);
    this.clearSoloState(sessionId); // [S1.1] a session's solo state goes with it
    return true;
  }

  // [S1.1] Beside each transcript, the solo runner's own state for that conversation: the taint its
  // turns carry forward and the runs parked on a held call (`solo/park.ts`). A sidecar, not a key of
  // the session record, because `migrateSessionRecord` rebuilds the record field by field and would
  // drop it. It lives in `solo/` so `list()` (files ending `.json` in this directory) never reads it
  // as a session, and it is written like a transcript: atomically, owner-only.
  public getSoloStateDir(): string {
    return path.join(this.sessionsDir, "solo");
  }

  public soloStatePath(sessionId: string): string {
    return path.join(this.getSoloStateDir(), path.basename(this.pathFor(sessionId)));
  }

  /** The saved state, parsed; undefined when there is none. Unparseable bytes are quarantined, never deleted. */
  public readSoloState(sessionId: string): unknown {
    const file = this.soloStatePath(sessionId);
    if (!this.io.existsSync(file)) return undefined;
    try {
      return JSON.parse(this.io.readFileSync(file, "utf8")) as unknown;
    } catch (err) {
      this.quarantine(file, `unparseable solo state: ${(err as Error).message}`);
      return undefined;
    }
  }

  public writeSoloState(sessionId: string, state: unknown): void {
    this.ensureDir(this.sessionsDir);
    this.ensureDir(this.getSoloStateDir());
    atomicWriteFileSync(this.io, this.soloStatePath(sessionId), JSON.stringify(state, null, 2), SESSION_FILE_MODE);
  }

  public clearSoloState(sessionId: string): boolean {
    const file = this.soloStatePath(sessionId);
    if (!this.io.existsSync(file)) return false;
    this.io.unlinkSync(file);
    return true;
  }

  /**
   * Retention. Defaults to keeping 30 days. The active session is exempt from both bounds — a
   * long-running resume must never have the file pulled out from under it.
   */
  public pruneSessions(options: PruneOptions = {}): PruneResult {
    const maxAgeDays = options.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS;
    const cutoff = Date.now() - maxAgeDays * 86_400_000;
    const sessions = this.list(); // newest first
    const removed: string[] = [];

    const isActive = (id: string): boolean => id === options.activeSessionId;

    const survivors: SessionData[] = [];
    for (const session of sessions) {
      const updated = new Date(session.updated_at).getTime();
      const tooOld = Number.isFinite(updated) && updated < cutoff;
      if (tooOld && !isActive(session.id)) {
        if (this.delete(session.id)) removed.push(session.id);
        continue;
      }
      survivors.push(session);
    }

    if (options.maxCount !== undefined && survivors.length > options.maxCount) {
      // survivors is newest-first; drop from the tail, skipping the active session.
      let budget = options.maxCount;
      for (const session of survivors) {
        if (isActive(session.id)) {
          budget = Math.max(0, budget - 1);
        }
      }
      let keptNonActive = 0;
      for (const session of survivors) {
        if (isActive(session.id)) continue;
        if (keptNonActive < budget) {
          keptNonActive += 1;
          continue;
        }
        if (this.delete(session.id)) removed.push(session.id);
      }
    }

    return { removed, kept: this.list().length };
  }

  public createNew(
    agent = "ceo",
    model = "gpt-5.6-terra",
    provider = "openai",
  ): SessionData {
    const id = `sess_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
    const now = new Date().toISOString();
    const session: SessionData = {
      schemaVersion: SESSION_SCHEMA_VERSION,
      id,
      title: "New Session",
      created_at: now,
      updated_at: now,
      agent,
      model,
      provider,
      messages: [],
      status: "active",
      total_cost_cents: 0,
      total_cost: 0,
      total_duration_ms: 0,
    };
    this.save(session);
    return session;
  }
}
