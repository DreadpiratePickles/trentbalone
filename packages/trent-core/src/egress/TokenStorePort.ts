/**
 * The narrow durable surface the token broker needs.
 *
 * `src/store/StorePort.ts` deliberately exposes only company/run/step/event/approval/job-run and
 * carries no token entity, so widening it is another agent's call. This port is defined here so the
 * broker can be durable today; wiring it to the SQLite store is a follow-up that only has to supply
 * one more implementation of this interface.
 */
import fs from "node:fs";
import path from "node:path";

export interface ProxyTokenRecord {
  token: string;
  agentId: string;
  toolsetName?: string;
  /** The real secrets. Never logged, never serialized into any surface a sandbox can read. */
  realCredentials: Record<string, string>;
  /**
   * The host(s) `realCredentials` belong to, as `host` or `host:port` (see `host-binding.ts`). The
   * broker writes the secret only onto a request to one of them or a subdomain of a named domain;
   * every other allowlisted host gets the request without it. Absent (a record minted before this
   * field, or by a caller that named no host) binds the secret to NOTHING: fail closed.
   */
  hosts?: string[];
  createdAt: string;
  expiresAt?: string;
  revoked: boolean;
}

export interface TokenStorePort {
  get(token: string): ProxyTokenRecord | null;
  put(record: ProxyTokenRecord): void;
  all(): ProxyTokenRecord[];
  delete(token: string): void;
}

/** Process-lifetime store. Correct only for tests and single-shot runs. */
export class MemoryTokenStore implements TokenStorePort {
  private readonly records = new Map<string, ProxyTokenRecord>();

  public get(token: string): ProxyTokenRecord | null {
    return this.records.get(token) ?? null;
  }

  public put(record: ProxyTokenRecord): void {
    this.records.set(record.token, record);
  }

  public all(): ProxyTokenRecord[] {
    return [...this.records.values()];
  }

  public delete(token: string): void {
    this.records.delete(token);
  }
}

/**
 * File-backed store. Every mutation is written through with an atomic rename so a revocation that
 * the caller has been told succeeded cannot be lost to a crash, and every read re-loads from disk so
 * a revocation performed by another process (`trent egress revoke`) takes effect immediately.
 */
export class FileTokenStore implements TokenStorePort {
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  public get(token: string): ProxyTokenRecord | null {
    return this.read().get(token) ?? null;
  }

  public put(record: ProxyTokenRecord): void {
    const records = this.read();
    records.set(record.token, record);
    this.write(records);
  }

  public all(): ProxyTokenRecord[] {
    return [...this.read().values()];
  }

  public delete(token: string): void {
    const records = this.read();
    if (records.delete(token)) this.write(records);
  }

  private read(): Map<string, ProxyTokenRecord> {
    if (!fs.existsSync(this.filePath)) return new Map();
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as unknown;
      if (!Array.isArray(parsed)) return new Map();
      return new Map(
        (parsed as ProxyTokenRecord[])
          .filter((r) => typeof r?.token === "string")
          .map((r) => [r.token, r])
      );
    } catch {
      // A truncated store must fail closed: no record resolves, so every request is refused.
      return new Map();
    }
  }

  private write(records: Map<string, ProxyTokenRecord>): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify([...records.values()], null, 2), { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, this.filePath);
    fs.chmodSync(this.filePath, 0o600);
  }
}
