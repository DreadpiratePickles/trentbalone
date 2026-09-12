import { describe, expect, it } from "vitest";
import {
  checkCache,
  putCache,
  evictCache,
  type CacheEntry,
} from "@/lib/generation/fingerprint-cache";
import { store } from "@/lib/store";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeCompany() {
  return store.createCompany({
    name: `FpCache-${Date.now()}-${Math.random()}`,
    budgetCents: 10_000,
    brief: { vision: "fingerprint cache tests" },
  });
}

const FP_A = "a".repeat(64); // valid SHA-256-length hex string
const FP_B = "b".repeat(64);

const IMAGE_ENTRY: Omit<CacheEntry, "fingerprint" | "createdAt"> = {
  r2Url:       "https://trent-co.r2.dev/images/abc123.png",
  taskType:    "image",
  qualityTier: "standard",
  ttlDays:     30,
};

const TEXT_ENTRY: Omit<CacheEntry, "fingerprint" | "createdAt"> = {
  text:        "Generated ad headline: Ship faster with Trent.",
  taskType:    "text",
  qualityTier: "draft",
  ttlDays:     30,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("fingerprint-cache", () => {
  // ── checkCache ─────────────────────────────────────────────────────────────

  describe("checkCache", () => {
    it("returns null on cache miss (fingerprint never stored)", async () => {
      const company = await makeCompany();
      const result = await checkCache(company.id, FP_A);
      expect(result).toBeNull();
    });

    it("returns the cached entry on cache hit", async () => {
      const company = await makeCompany();
      await putCache(company.id, FP_A, IMAGE_ENTRY);

      const result = await checkCache(company.id, FP_A);
      expect(result).not.toBeNull();
      expect(result!.r2Url).toBe("https://trent-co.r2.dev/images/abc123.png");
      expect(result!.taskType).toBe("image");
      expect(result!.qualityTier).toBe("standard");
    });

    it("returns null for a different fingerprint (no false positive)", async () => {
      const company = await makeCompany();
      await putCache(company.id, FP_A, IMAGE_ENTRY);

      const result = await checkCache(company.id, FP_B);
      expect(result).toBeNull();
    });

    it("cache is per-company — company A's entry is not visible to company B", async () => {
      const companyA = await makeCompany();
      const companyB = await makeCompany();
      await putCache(companyA.id, FP_A, IMAGE_ENTRY);

      const result = await checkCache(companyB.id, FP_A);
      expect(result).toBeNull();
    });

    it("returns null for an expired entry (ttlDays elapsed)", async () => {
      const company = await makeCompany();
      // Put an entry that expired 1 day ago
      const expiredEntry: CacheEntry = {
        fingerprint: FP_A,
        ...IMAGE_ENTRY,
        createdAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString(), // 31 days ago
        ttlDays: 30,
      };
      await putCache(company.id, FP_A, expiredEntry);

      const result = await checkCache(company.id, FP_A);
      expect(result).toBeNull();
    });

    it("returns a valid entry that has not yet expired", async () => {
      const company = await makeCompany();
      await putCache(company.id, FP_A, { ...IMAGE_ENTRY, ttlDays: 30 });

      const result = await checkCache(company.id, FP_A);
      expect(result).not.toBeNull();
    });

    it("caches text entries (text field, no r2Url)", async () => {
      const company = await makeCompany();
      await putCache(company.id, FP_B, TEXT_ENTRY);

      const result = await checkCache(company.id, FP_B);
      expect(result).not.toBeNull();
      expect(result!.text).toBe("Generated ad headline: Ship faster with Trent.");
      expect(result!.r2Url).toBeUndefined();
    });
  });

  // ── putCache ───────────────────────────────────────────────────────────────

  describe("putCache", () => {
    it("overwrites an existing entry for the same fingerprint (idempotent put)", async () => {
      const company = await makeCompany();
      await putCache(company.id, FP_A, IMAGE_ENTRY);
      await putCache(company.id, FP_A, { ...IMAGE_ENTRY, r2Url: "https://trent-co.r2.dev/updated.png" });

      const result = await checkCache(company.id, FP_A);
      expect(result!.r2Url).toBe("https://trent-co.r2.dev/updated.png");
    });

    it("stores createdAt automatically when not provided in the entry", async () => {
      const company = await makeCompany();
      const before  = Date.now();
      await putCache(company.id, FP_A, IMAGE_ENTRY);

      const result = await checkCache(company.id, FP_A);
      expect(result!.createdAt).toBeTruthy();
      expect(new Date(result!.createdAt).getTime()).toBeGreaterThanOrEqual(before);
    });
  });

  // ── evictCache ─────────────────────────────────────────────────────────────

  describe("evictCache", () => {
    it("removes the entry so subsequent checkCache returns null", async () => {
      const company = await makeCompany();
      await putCache(company.id, FP_A, IMAGE_ENTRY);
      await evictCache(company.id, FP_A);

      const result = await checkCache(company.id, FP_A);
      expect(result).toBeNull();
    });

    it("evicting a non-existent entry is a no-op (does not throw)", async () => {
      const company = await makeCompany();
      await expect(evictCache(company.id, FP_A)).resolves.not.toThrow();
    });
  });
});
