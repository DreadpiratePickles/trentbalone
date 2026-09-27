/**
 * Credential brokering: the sandbox holds an opaque token, the host holds the secret.
 *
 * The previous implementation was an in-memory Map, so tokens died with the process and could not
 * be revoked across a restart - a revocation issued in one CLI invocation had no effect on a proxy
 * already running, and a restarted proxy silently re-opened nothing at all. Storage is now a port
 * (`TokenStorePort`) and defaults to a file-backed implementation.
 */
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import {
  FileTokenStore,
  MemoryTokenStore,
  type ProxyTokenRecord,
  type TokenStorePort,
} from "./TokenStorePort.js";
import { normalizeCredentialHosts } from "./host-binding.js";

export type { ProxyTokenRecord, TokenStorePort } from "./TokenStorePort.js";

export interface TokenManagerOptions {
  /** Supply a store directly (SQLite-backed, once `src/store/` exposes tokens). */
  store?: TokenStorePort;
  /** Or a path for the built-in file store. Defaults to ~/.trent/egress/tokens.json. */
  filePath?: string;
  /** Opt out of durability explicitly; nothing production should. */
  ephemeral?: boolean;
}

/** The options form of `issueToken`'s last argument. */
export interface IssueTokenOptions {
  ttlSeconds?: number;
  /**
   * The host(s) the credentials belong to, `host` or `host:port`. The broker injects the secret
   * only into requests to these (see `host-binding.ts`); omitted, it injects it nowhere.
   */
  hosts?: readonly string[];
}

export const TOKEN_PREFIX = "trnt_egress_";

/**
 * Where a Trent home keeps its egress token store: `<baseDir>/egress/tokens.json`. The egress
 * material (CA + tokens) is global to a home, not per-profile, so callers that only know the base
 * dir (`ConfigManager.getBaseDir()`) can point a `TokenManager` at the very file the running proxy
 * validates against — which is how `trent panic` revokes live tokens from a separate process.
 */
export function egressTokenStorePath(baseDir: string): string {
  return path.join(baseDir, "egress", "tokens.json");
}

function defaultTokenPath(): string {
  return egressTokenStorePath(path.join(os.homedir(), ".trent"));
}

function isExpired(record: ProxyTokenRecord, now: number): boolean {
  return record.expiresAt !== undefined && new Date(record.expiresAt).getTime() <= now;
}

export class TokenManager {
  private readonly store: TokenStorePort;

  constructor(options?: TokenManagerOptions) {
    if (options?.store) {
      this.store = options.store;
    } else if (options?.ephemeral) {
      this.store = new MemoryTokenStore();
    } else {
      this.store = new FileTokenStore(options?.filePath ?? defaultTokenPath());
    }
  }

  /**
   * Mint an opaque token standing in for `realCredentials`. The returned string is the only value
   * that may enter a sandbox. The last argument is a TTL in seconds or `{ ttlSeconds, hosts }`; a
   * token minted without `hosts` is bound to no host, so its secret is injected nowhere.
   */
  public issueToken(
    agentId: string,
    realCredentials: Record<string, string>,
    toolsetName?: string,
    ttlOrOptions?: number | IssueTokenOptions
  ): string {
    const options: IssueTokenOptions = typeof ttlOrOptions === "number" ? { ttlSeconds: ttlOrOptions } : ttlOrOptions ?? {};
    const ttlSeconds = options.ttlSeconds;
    // Validated before anything is stored: a refused binding mints nothing.
    const hosts = options.hosts === undefined ? undefined : normalizeCredentialHosts(options.hosts);
    const token = `${TOKEN_PREFIX}${crypto.randomBytes(16).toString("hex")}`;
    const now = new Date();
    this.store.put({
      token,
      agentId,
      toolsetName,
      realCredentials,
      ...(hosts === undefined ? {} : { hosts }),
      createdAt: now.toISOString(),
      expiresAt:
        ttlSeconds === undefined
          ? undefined
          : new Date(now.getTime() + ttlSeconds * 1000).toISOString(),
      revoked: false,
    });
    return token;
  }

  /** Resolve a token to its record, or null. Null means REFUSE - never means "forward anyway". */
  public resolveToken(token: string): ProxyTokenRecord | null {
    if (typeof token !== "string" || !token.startsWith(TOKEN_PREFIX)) return null;
    const record = this.store.get(token);
    if (!record || record.revoked) return null;
    if (isExpired(record, Date.now())) return null;
    return record;
  }

  public revokeToken(token: string): boolean {
    const record = this.store.get(token);
    if (!record) return false;
    this.store.put({ ...record, revoked: true });
    return true;
  }

  public revokeAllForAgent(agentId: string): number {
    let count = 0;
    for (const record of this.store.all()) {
      if (record.agentId === agentId && !record.revoked) {
        this.store.put({ ...record, revoked: true });
        count++;
      }
    }
    return count;
  }

  /**
   * The kill switch: mark EVERY still-valid token revoked and return how many were dropped. After
   * it, `resolveToken` - and therefore the `EgressProxy`, which validates through it - refuses every
   * previously-valid token, so an in-flight agent step still holding one can make no further
   * outbound call. Already-revoked or expired records are not "valid" and are neither re-touched nor
   * counted, so the return value is exactly the number of live tokens this call took down (matching
   * `listActiveTokens().length` at the moment it runs).
   */
  public revokeAll(): number {
    const now = Date.now();
    let count = 0;
    for (const record of this.store.all()) {
      if (!record.revoked && !isExpired(record, now)) {
        this.store.put({ ...record, revoked: true });
        count++;
      }
    }
    return count;
  }

  /** Remove records that are revoked or expired. Safe to call on start. */
  public prune(): number {
    const now = Date.now();
    let removed = 0;
    for (const record of this.store.all()) {
      if (record.revoked || isExpired(record, now)) {
        this.store.delete(record.token);
        removed++;
      }
    }
    return removed;
  }

  /** Metadata only. `realCredentials` is stripped so no caller can accidentally render a secret. */
  public listActiveTokens(): Array<Omit<ProxyTokenRecord, "realCredentials">> {
    const now = Date.now();
    return this.store
      .all()
      .filter((r) => !r.revoked && !isExpired(r, now))
      .map(({ realCredentials: _omitted, ...rest }) => rest);
  }
}
