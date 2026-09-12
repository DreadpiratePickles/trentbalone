import crypto from "node:crypto";

export interface ProxyTokenRecord {
  token: string;
  agentId: string;
  toolsetName?: string;
  realCredentials: Record<string, string>;
  createdAt: string;
  expiresAt?: string;
  revoked: boolean;
}

export class TokenManager {
  private tokens: Map<string, ProxyTokenRecord> = new Map();

  public issueToken(
    agentId: string,
    realCredentials: Record<string, string>,
    toolsetName?: string,
    ttlSeconds?: number
  ): string {
    const random = crypto.randomBytes(16).toString("hex");
    const token = `trnt_egress_${random}`;

    const now = new Date();
    const expiresAt = ttlSeconds
      ? new Date(now.getTime() + ttlSeconds * 1000).toISOString()
      : undefined;

    this.tokens.set(token, {
      token,
      agentId,
      toolsetName,
      realCredentials,
      createdAt: now.toISOString(),
      expiresAt,
      revoked: false,
    });

    return token;
  }

  public resolveToken(token: string): ProxyTokenRecord | null {
    const record = this.tokens.get(token);
    if (!record || record.revoked) {
      return null;
    }

    if (record.expiresAt && new Date(record.expiresAt).getTime() < Date.now()) {
      return null;
    }

    return record;
  }

  public revokeToken(token: string): boolean {
    const record = this.tokens.get(token);
    if (record) {
      record.revoked = true;
      return true;
    }
    return false;
  }

  public revokeAllForAgent(agentId: string): number {
    let count = 0;
    for (const record of this.tokens.values()) {
      if (record.agentId === agentId && !record.revoked) {
        record.revoked = true;
        count++;
      }
    }
    return count;
  }

  public listActiveTokens(): Array<Omit<ProxyTokenRecord, "realCredentials">> {
    return Array.from(this.tokens.values())
      .filter((r) => !r.revoked && (!r.expiresAt || new Date(r.expiresAt).getTime() > Date.now()))
      .map(({ realCredentials, ...rest }) => rest);
  }
}
