/**
 * lib/generation/fingerprint-cache.ts
 *
 * Per-company generation cache keyed by SHA-256 input fingerprint.
 *
 * Design:
 *  - Exact-match only. Near-duplicate detection (embedding similarity) is Phase 5.
 *  - Per-company: company A's cached assets are not shared with company B.
 *  - TTL-based expiry: entries older than ttlDays are lazily evicted on lookup.
 *  - Stores both media entries (r2Url) and text entries (text).
 *  - Storage: per-company Integration record with provider "FingerprintCache:{fp}".
 *    Same encrypted store pattern as provisioners and brand memory.
 *
 * Wiring:
 *  The API surface (build item 15) calls checkCache before generateImage/generateText.
 *  The routers themselves stay pure — they don't call the cache.
 *
 * Depends on:
 *  - lib/secrets.ts  — encryption
 *  - lib/store.ts    — Integration CRUD
 */

import { encryptJson, decryptJson } from "@/lib/secrets";
import { store } from "@/lib/store";
import type { QualityTier, GenerationTaskType } from "@/lib/generation/cost-optimizer";

// ── Public types ──────────────────────────────────────────────────────────────

export type CacheEntry = {
  fingerprint: string;
  /** R2 CDN URL. Present for image, audio, video, music entries. */
  r2Url?: string;
  /** Generated text. Present for text entries. */
  text?: string;
  taskType: GenerationTaskType;
  qualityTier: QualityTier;
  createdAt: string;
  ttlDays: number;
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function cacheKey(fingerprint: string): string {
  return `FingerprintCache:${fingerprint}`;
}

function isExpired(entry: CacheEntry): boolean {
  const expiresAt = new Date(entry.createdAt).getTime() + entry.ttlDays * 24 * 60 * 60 * 1000;
  return Date.now() > expiresAt;
}

// ── checkCache ────────────────────────────────────────────────────────────────

/**
 * Look up a generation result by fingerprint.
 *
 * Returns null on miss, on TTL expiry (lazy eviction), or if the entry is corrupt.
 */
export async function checkCache(
  companyId: string,
  fingerprint: string
): Promise<CacheEntry | null> {
  const integration = await store.getIntegration(companyId, cacheKey(fingerprint));
  if (!integration?.encryptedData) return null;

  let entry: CacheEntry;
  try {
    entry = decryptJson<CacheEntry>(integration.encryptedData);
  } catch {
    return null;
  }

  if (isExpired(entry)) {
    // Lazy eviction — don't await, fire-and-forget
    evictCache(companyId, fingerprint).catch(() => undefined);
    return null;
  }

  return entry;
}

// ── putCache ──────────────────────────────────────────────────────────────────

/**
 * Store a generation result in the cache.
 *
 * Accepts a full CacheEntry (with existing createdAt) or a partial entry
 * (without createdAt) — in the latter case createdAt is set to now.
 * Overwrites any existing entry for the same fingerprint (idempotent).
 */
export async function putCache(
  companyId: string,
  fingerprint: string,
  input: Omit<CacheEntry, "fingerprint" | "createdAt"> | CacheEntry
): Promise<void> {
  const entry: CacheEntry = {
    fingerprint,
    createdAt: "createdAt" in input ? input.createdAt : new Date().toISOString(),
    ...input,
  };

  await store.upsertIntegration({
    companyId,
    provider:      cacheKey(fingerprint),
    scopes:        ["cache"],
    status:        "connected",
    encryptedData: encryptJson(entry),
  });
}

// ── evictCache ────────────────────────────────────────────────────────────────

/** Remove a cached entry. No-op if the entry does not exist. */
export async function evictCache(
  companyId: string,
  fingerprint: string
): Promise<void> {
  const integration = await store.getIntegration(companyId, cacheKey(fingerprint));
  if (integration) {
    await store.revokeIntegration(integration.id);
  }
}
