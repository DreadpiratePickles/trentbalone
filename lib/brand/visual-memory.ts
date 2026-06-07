/**
 * lib/brand/visual-memory.ts
 *
 * Brand visual identity storage and injection for AI image generation.
 *
 * Design:
 *  - setVisualProfile()    — explicitly set by the founder; no LLM derivation.
 *  - getVisualProfile()    — loads the stored profile for a company.
 *  - getVisualContext()    — pure formatter: converts a profile into
 *                            { positivePrompt?, negativePrompt? } ready to inject
 *                            into ImageGenerationRequest.visualContext.
 *
 * Storage: per-company Integration record with provider "BrandVisual-Profile",
 * encrypted via secrets.ts. Same pattern as provisioners and voice-memory.
 *
 * Profile schema is LOCKED after the first company sets a profile.
 * Changing field names requires migrating every company's visual memory.
 *
 * Depends on (build order enforced):
 *  - lib/secrets.ts (Phase 0) — encryption
 *  - lib/store.ts             — Integration CRUD
 */

import { encryptJson, decryptJson } from "@/lib/secrets";
import { store } from "@/lib/store";

// ── Public types ──────────────────────────────────────────────────────────────

export type BrandVisualProfile = {
  /** R2 URL of the brand logo. */
  logoUrl?: string;
  /** Brand palette hex codes, e.g. ["#1A2B3C", "#FFFFFF"]. */
  palette: string[];
  /** Font family names, e.g. ["Inter", "Playfair Display"]. */
  typography: string[];
  /** R2 URLs of curated reference images for style consistency. */
  referenceImageUrls: string[];
  /** Terms that should NOT appear in generated imagery. */
  negativeTerms: string[];
  /** ISO timestamp of last update. Set automatically by setVisualProfile. */
  updatedAt: string;
};

// ── Constants ─────────────────────────────────────────────────────────────────

const PROVIDER_KEY = "BrandVisual-Profile";

// ── Storage helpers ───────────────────────────────────────────────────────────

async function load(companyId: string): Promise<BrandVisualProfile | null> {
  const integration = await store.getIntegration(companyId, PROVIDER_KEY);
  if (!integration?.encryptedData) return null;
  try {
    return decryptJson<BrandVisualProfile>(integration.encryptedData);
  } catch {
    return null;
  }
}

async function save(companyId: string, profile: BrandVisualProfile): Promise<void> {
  await store.upsertIntegration({
    companyId,
    provider:      PROVIDER_KEY,
    scopes:        ["brand"],
    status:        "connected",
    encryptedData: encryptJson(profile),
  });
}

// ── setVisualProfile ──────────────────────────────────────────────────────────

/**
 * Store a brand visual profile for a company (full replace — not a patch).
 * Adds updatedAt automatically.
 */
export async function setVisualProfile(
  companyId: string,
  input: Omit<BrandVisualProfile, "updatedAt">
): Promise<BrandVisualProfile> {
  const profile: BrandVisualProfile = {
    ...input,
    updatedAt: new Date().toISOString(),
  };
  await save(companyId, profile);
  return profile;
}

// ── getVisualProfile ──────────────────────────────────────────────────────────

/** Load the stored brand visual profile. Returns null if not yet set. */
export async function getVisualProfile(companyId: string): Promise<BrandVisualProfile | null> {
  return load(companyId);
}

// ── getVisualContext ──────────────────────────────────────────────────────────

/**
 * Pure formatter — converts a BrandVisualProfile into the visualContext shape
 * expected by ImageGenerationRequest.
 *
 * Returns undefined fields (not empty strings) when content is absent,
 * so image-router's truthiness checks work correctly.
 */
export function getVisualContext(
  profile: BrandVisualProfile
): { positivePrompt?: string; negativePrompt?: string } {
  // Build positive prompt parts
  const parts: string[] = [];

  if (profile.palette.length > 0) {
    parts.push(`color palette: ${profile.palette.join(", ")}`);
  }
  if (profile.typography.length > 0) {
    parts.push(`typography: ${profile.typography.join(", ")} style`);
  }
  if (profile.logoUrl) {
    parts.push("maintain brand logo visibility and style");
  }
  if (profile.referenceImageUrls.length > 0) {
    parts.push("consistent with brand reference imagery style");
  }

  const positivePrompt = parts.length > 0 ? parts.join("; ") : undefined;

  // Build negative prompt
  const negativePrompt = profile.negativeTerms.length > 0
    ? profile.negativeTerms.join(", ")
    : undefined;

  return { positivePrompt, negativePrompt };
}
