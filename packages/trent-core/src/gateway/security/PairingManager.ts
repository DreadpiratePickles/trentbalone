/**
 * Default-deny sender policy with DM pairing codes, after Hermes.
 *
 * An unknown sender is never routed to an agent. They receive a short CSPRNG code; the
 * operator runs `trent gateway pair <platform> <code>` to approve them at a tier. Tiers
 * are per scope: an admin in DMs is still nobody in a group until granted there.
 */

import crypto from "node:crypto";
import type { GatewayStore, PairingRow, Tier } from "../store/GatewayStore.js";
import type { Scope } from "../transport/types.js";

export const PAIRING_CODE_TTL_MS = 60 * 60 * 1000;
export const PAIRING_CODE_LENGTH = 8;
/** Codes a single sender may be issued per rate window before they are ignored outright. */
export const PAIRING_MAX_CODES_PER_WINDOW = 3;
export const PAIRING_RATE_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Unambiguous alphabet: no 0/O, 1/I. */
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export interface AuthorizeInput {
  platform: string;
  senderId: string;
  scope: Scope;
  channelId?: string;
}

export type AuthorizeDecision =
  | { allowed: true; tier: Tier }
  | { allowed: false; reason: "pairing_required"; code: string; fresh: boolean }
  | { allowed: false; reason: "rate_limited" }
  | { allowed: false; reason: "group_not_paired" };

export interface PairingOptions {
  now?: () => number;
}

export function generatePairingCode(length = PAIRING_CODE_LENGTH): string {
  const bytes = crypto.randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

export class PairingManager {
  private readonly now: () => number;

  constructor(private readonly store: GatewayStore, options: PairingOptions = {}) {
    this.now = options.now ?? (() => Date.now());
  }

  tierFor(platform: string, senderId: string, scope: Scope): Tier | null {
    const row = this.store
      .snapshot()
      .pairings.find((p) => p.platform === platform && p.senderId === senderId && p.scope === scope);
    return row ? row.tier : null;
  }

  isAdmin(platform: string, senderId: string, scope: Scope): boolean {
    return this.tierFor(platform, senderId, scope) === "admin";
  }

  grant(input: { platform: string; senderId: string; scope: Scope; tier: Tier }): PairingRow {
    const row: PairingRow = { ...input, pairedAt: new Date(this.now()).toISOString() };
    this.store.mutate((s) => {
      s.pairings = s.pairings.filter(
        (p) => !(p.platform === row.platform && p.senderId === row.senderId && p.scope === row.scope),
      );
      s.pairings.push(row);
    });
    return row;
  }

  revoke(platform: string, senderId: string, scope?: Scope): number {
    return this.store.mutate((s) => {
      const before = s.pairings.length;
      s.pairings = s.pairings.filter(
        (p) => !(p.platform === platform && p.senderId === senderId && (scope === undefined || p.scope === scope)),
      );
      return before - s.pairings.length;
    });
  }

  list(): PairingRow[] {
    return this.store.snapshot().pairings;
  }

  /**
   * The single policy gate every inbound message passes through. Group senders are never
   * offered a code in the group; pairing happens over DM, then the operator grants group scope.
   */
  authorize(input: AuthorizeInput): AuthorizeDecision {
    const tier = this.tierFor(input.platform, input.senderId, input.scope);
    if (tier) return { allowed: true, tier };
    if (input.scope === "group") return { allowed: false, reason: "group_not_paired" };

    const now = this.now();
    return this.store.mutate((s) => {
      // Expired codes stay on file for the rate window so re-issuance is still counted.
      s.pairingCodes = s.pairingCodes.filter((c) => c.issuedAt > now - PAIRING_RATE_WINDOW_MS);
      const mine = s.pairingCodes.filter((c) => c.platform === input.platform && c.senderId === input.senderId);
      const live = mine.find((c) => c.expiresAt > now);
      if (live) return { allowed: false, reason: "pairing_required", code: live.code, fresh: false };
      if (mine.length >= PAIRING_MAX_CODES_PER_WINDOW) return { allowed: false, reason: "rate_limited" };
      const code = generatePairingCode();
      s.pairingCodes.push({
        code,
        platform: input.platform,
        senderId: input.senderId,
        scope: input.scope,
        channelId: input.channelId,
        issuedAt: now,
        expiresAt: now + PAIRING_CODE_TTL_MS,
      });
      return { allowed: false, reason: "pairing_required", code, fresh: true };
    });
  }

  /** `trent gateway pair <platform> <code> [--admin]` lands here. */
  pair(platform: string, code: string, tier: Tier): PairingRow {
    const now = this.now();
    const normalized = code.trim().toUpperCase();
    const row = this.store.mutate((s) => {
      const idx = s.pairingCodes.findIndex(
        (c) => c.platform === platform && c.code === normalized && c.expiresAt > now,
      );
      if (idx === -1) return null;
      const [found] = s.pairingCodes.splice(idx, 1);
      // Consume every other outstanding code for this sender too.
      s.pairingCodes = s.pairingCodes.filter((c) => !(c.platform === platform && c.senderId === found.senderId));
      return found;
    });
    if (!row) throw new Error(`Pairing failed: unknown or expired code for ${platform}.`);
    return this.grant({ platform, senderId: row.senderId, scope: row.scope, tier });
  }

  listPendingCodes(): Array<{ platform: string; senderId: string; expiresAt: string }> {
    const now = this.now();
    return this.store
      .snapshot()
      .pairingCodes.filter((c) => c.expiresAt > now)
      .map((c) => ({ platform: c.platform, senderId: c.senderId, expiresAt: new Date(c.expiresAt).toISOString() }));
  }
}
