/**
 * Fleet spend ledger. INTEGER CENTS, durable, per profile.
 *
 * `getStatus().dailyBudgetSpent` used to be a hard-coded 0.0 — a number that looked measured and
 * was not. This is the measurement: a keyed ledger at `<profile>/fleet-usage.json`, fed both by
 * explicit `record()` calls and by ingesting the per-message costs the session store already
 * writes. Ingest is keyed by `session:<id>:<messageId>`, so re-reading a session can never count
 * the same spend twice.
 */

import path from "node:path";
import { ConfigManager } from "../config/ConfigManager.js";
import { NODE_IO, atomicWriteFileSync } from "../config/atomic-fs.js";
import { SessionStore } from "../sessions/SessionStore.js";

const LEDGER_FILE = "fleet-usage.json";
const LEDGER_VERSION = 1;
const LEDGER_MODE = 0o600;
/** Entries older than this are dropped on write so the file stays bounded. */
const RETENTION_DAYS = 90;

export interface SpendEntry {
  agentId: string;
  /** INTEGER CENTS. */
  cents: number;
  /** ISO 8601 timestamp. */
  at: string;
}

export interface RecordSpendOptions {
  /** Idempotency key. A repeated key overwrites rather than accumulates. */
  key?: string;
  /** ISO timestamp for the spend. Defaults to now. */
  at?: string;
}

interface Ledger {
  version: number;
  entries: Record<string, SpendEntry>;
}

/** UTC calendar day, so "today" does not shift with the reader's timezone. */
export function utcDay(at: string | Date): string {
  const date = typeof at === "string" ? new Date(at) : at;
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString().slice(0, 10);
}

export class FleetUsage {
  private configManager: ConfigManager;
  private counter = 0;

  constructor(configManager?: ConfigManager) {
    this.configManager = configManager || new ConfigManager();
  }

  public getLedgerPath(): string {
    return path.join(this.configManager.getProfileDir(), LEDGER_FILE);
  }

  /** Record spend in INTEGER CENTS. Non-integer, negative and non-finite inputs are rejected. */
  public record(agentId: string, cents: number, options?: RecordSpendOptions): SpendEntry {
    if (!Number.isFinite(cents) || cents < 0) {
      throw new RangeError(`spend must be a non-negative number of cents, got ${cents}`);
    }
    const entry: SpendEntry = {
      agentId,
      cents: Math.round(cents),
      at: options?.at ?? new Date().toISOString(),
    };
    const key = options?.key ?? `manual:${entry.at}:${this.counter++}`;

    const ledger = this.load();
    ledger.entries[key] = entry;
    this.save(ledger);
    return entry;
  }

  /**
   * Pull per-message costs out of the session store into the ledger. Keyed per message, so
   * calling it on every status read is safe.
   */
  public ingestSessions(): number {
    let sessions;
    try {
      sessions = new SessionStore(this.configManager.getSessionsDir()).list();
    } catch {
      return 0;
    }

    const ledger = this.load();
    let added = 0;

    for (const session of sessions) {
      let index = 0;
      for (const message of session.messages) {
        const cents = message.metadata?.cost_cents;
        index += 1;
        if (typeof cents !== "number" || !Number.isFinite(cents) || cents <= 0) continue;

        const key = `session:${session.id}:${message.id || index}`;
        if (ledger.entries[key]) continue;

        ledger.entries[key] = {
          agentId: message.agent || session.agent,
          cents: Math.round(cents),
          at: message.timestamp || session.updated_at,
        };
        added += 1;
      }
    }

    if (added > 0) this.save(ledger);
    return added;
  }

  /** Total spend for the UTC day containing `now`, in INTEGER CENTS. */
  public spentTodayCents(now: Date = new Date()): number {
    this.ingestSessions();
    const day = utcDay(now);
    let total = 0;
    for (const entry of Object.values(this.load().entries)) {
      if (utcDay(entry.at) === day) total += entry.cents;
    }
    return total;
  }

  /** Spend for the UTC day containing `now`, broken down by agent id. */
  public spentTodayByAgent(now: Date = new Date()): Record<string, number> {
    this.ingestSessions();
    const day = utcDay(now);
    const out: Record<string, number> = {};
    for (const entry of Object.values(this.load().entries)) {
      if (utcDay(entry.at) !== day) continue;
      out[entry.agentId] = (out[entry.agentId] ?? 0) + entry.cents;
    }
    return out;
  }

  public entries(): SpendEntry[] {
    return Object.values(this.load().entries).sort((a, b) => a.at.localeCompare(b.at));
  }

  // ------------------------------------------------------------------ storage

  private load(): Ledger {
    const file = this.getLedgerPath();
    if (!NODE_IO.existsSync(file)) return { version: LEDGER_VERSION, entries: {} };

    try {
      const parsed = JSON.parse(NODE_IO.readFileSync(file, "utf8")) as Partial<Ledger>;
      const entries: Record<string, SpendEntry> = {};
      for (const [key, value] of Object.entries(parsed.entries ?? {})) {
        if (!value || typeof value.cents !== "number" || typeof value.at !== "string") continue;
        entries[key] = {
          agentId: typeof value.agentId === "string" ? value.agentId : "unknown",
          cents: Math.round(value.cents),
          at: value.at,
        };
      }
      return { version: LEDGER_VERSION, entries };
    } catch {
      // A corrupt ledger must not take the fleet down; it reads as no recorded spend.
      return { version: LEDGER_VERSION, entries: {} };
    }
  }

  private save(ledger: Ledger): void {
    this.configManager.ensureDirs();
    const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
    const kept: Record<string, SpendEntry> = {};
    for (const [key, entry] of Object.entries(ledger.entries)) {
      const at = new Date(entry.at).getTime();
      if (Number.isNaN(at) || at >= cutoff) kept[key] = entry;
    }
    atomicWriteFileSync(
      NODE_IO,
      this.getLedgerPath(),
      JSON.stringify({ version: LEDGER_VERSION, entries: kept }, null, 2),
      LEDGER_MODE,
    );
  }
}
