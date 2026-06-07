/**
 * lib/brand/voice-memory.ts
 *
 * Brand voice derivation and enforcement for AI-generated text.
 *
 * Design:
 *  - deriveVoiceProfile()    — calls text-router (draft tier) to analyze samples
 *                              and extract structured voice attributes as JSON.
 *  - getVoiceProfile()       — loads the stored profile for a company.
 *  - getBrandVoiceContext()  — pure formatter: turns a profile into a string
 *                              ready to inject into TextGenerationRequest.brandVoiceContext.
 *
 * Storage: per-company Integration record with provider "BrandVoice-Profile",
 * encrypted via secrets.ts. Same pattern as provisioners.
 *
 * Confidence tiers:
 *  - 1 sample  → "low"
 *  - 2 samples → "medium"
 *  - 3+samples → "high"
 *
 * Malformed LLM JSON → fallback generic profile with confidence "low" (never throws).
 *
 * Depends on (build order enforced):
 *  - lib/generation/text-router.ts (build item 2) — used for derivation call
 *  - lib/secrets.ts (Phase 0) — encryption
 *  - lib/store.ts — Integration CRUD
 */

import { encryptJson, decryptJson } from "@/lib/secrets";
import { store } from "@/lib/store";
import { generateText } from "@/lib/generation/text-router";
import type { TextProvider } from "@/lib/generation/text-router";

// ── Public types ──────────────────────────────────────────────────────────────

export type BrandVoiceProfile = {
  toneMarkers: string[];
  vocabularyStyle: string;
  prohibitedPhrases: string[];
  preferredCTAs: string[];
  sampleCount: number;
  confidence: "low" | "medium" | "high";
  derivedAt: string;
};

export type VoiceMemoryOptions = {
  /** Override text providers for testing. Passed to generateText. */
  textProviders?: TextProvider[];
};

// ── Error types ───────────────────────────────────────────────────────────────

export class InsufficientSamplesError extends Error {
  constructor() {
    super("At least one writing sample is required to derive a brand voice profile.");
    this.name = "InsufficientSamplesError";
  }
}

// ── Constants ─────────────────────────────────────────────────────────────────

const PROVIDER_KEY = "BrandVoice-Profile";

const DERIVATION_SYSTEM_PROMPT = `You are a brand voice analyst. Analyze writing samples and extract a structured brand voice profile.

Output ONLY valid JSON — no markdown, no code fences, no explanation. Use this exact structure:
{
  "toneMarkers": ["2 to 5 tone descriptors, e.g. conversational, authoritative, playful"],
  "vocabularyStyle": "one sentence describing sentence structure, vocabulary, and writing patterns",
  "prohibitedPhrases": ["corporate jargon or off-brand phrases to avoid"],
  "preferredCTAs": ["action phrases or sign-offs this brand uses"]
}`;

const FALLBACK_PROFILE: Pick<
  BrandVoiceProfile,
  "toneMarkers" | "vocabularyStyle" | "prohibitedPhrases" | "preferredCTAs"
> = {
  toneMarkers:      ["professional"],
  vocabularyStyle:  "Clear and concise.",
  prohibitedPhrases: [],
  preferredCTAs:    [],
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function confidenceFor(sampleCount: number): BrandVoiceProfile["confidence"] {
  if (sampleCount >= 3) return "high";
  if (sampleCount === 2) return "medium";
  return "low";
}

function parseProfileJson(raw: string): Pick<
  BrandVoiceProfile,
  "toneMarkers" | "vocabularyStyle" | "prohibitedPhrases" | "preferredCTAs"
> | null {
  try {
    const parsed = JSON.parse(raw.trim());
    if (
      Array.isArray(parsed.toneMarkers) &&
      typeof parsed.vocabularyStyle === "string" &&
      Array.isArray(parsed.prohibitedPhrases) &&
      Array.isArray(parsed.preferredCTAs)
    ) {
      return {
        toneMarkers:      parsed.toneMarkers as string[],
        vocabularyStyle:  parsed.vocabularyStyle as string,
        prohibitedPhrases: parsed.prohibitedPhrases as string[],
        preferredCTAs:    parsed.preferredCTAs as string[],
      };
    }
    return null;
  } catch {
    return null;
  }
}

async function load(companyId: string): Promise<BrandVoiceProfile | null> {
  const integration = await store.getIntegration(companyId, PROVIDER_KEY);
  if (!integration?.encryptedData) return null;
  try {
    return decryptJson<BrandVoiceProfile>(integration.encryptedData);
  } catch {
    return null;
  }
}

async function save(companyId: string, profile: BrandVoiceProfile): Promise<void> {
  await store.upsertIntegration({
    companyId,
    provider:      PROVIDER_KEY,
    scopes:        ["brand"],
    status:        "connected",
    encryptedData: encryptJson(profile),
  });
}

// ── deriveVoiceProfile ────────────────────────────────────────────────────────

/**
 * Analyze writing samples and derive a structured brand voice profile.
 *
 * Calls text-router at draft tier to extract voice attributes as JSON.
 * Stores the result encrypted per company — overwrites any existing profile.
 * On LLM JSON parse failure: stores a fallback profile (never throws on parse).
 */
export async function deriveVoiceProfile(
  companyId: string,
  samples: string[],
  options?: VoiceMemoryOptions
): Promise<BrandVoiceProfile> {
  if (samples.length === 0) throw new InsufficientSamplesError();

  const sampleBlock = samples
    .map((s, i) => `[Sample ${i + 1}]: ${s}`)
    .join("\n\n");

  const prompt = `Analyze these writing samples and extract the brand voice profile:\n\n${sampleBlock}\n\nOutput only the JSON object.`;

  const result = await generateText(
    {
      companyId,
      qualityTier:  "draft",
      systemPrompt: DERIVATION_SYSTEM_PROMPT,
      prompt,
      description:  "brand-voice-derivation",
    },
    { providers: options?.textProviders }
  );

  const parsed = parseProfileJson(result.text);
  const attrs  = parsed ?? FALLBACK_PROFILE;

  const profile: BrandVoiceProfile = {
    ...attrs,
    sampleCount: samples.length,
    confidence:  parsed ? confidenceFor(samples.length) : "low",
    derivedAt:   new Date().toISOString(),
  };

  await save(companyId, profile);
  return profile;
}

// ── getVoiceProfile ───────────────────────────────────────────────────────────

/** Load the stored brand voice profile for a company. Returns null if not yet derived. */
export async function getVoiceProfile(companyId: string): Promise<BrandVoiceProfile | null> {
  return load(companyId);
}

// ── getBrandVoiceContext ──────────────────────────────────────────────────────

/**
 * Pure formatter — converts a BrandVoiceProfile into a string ready to inject
 * into TextGenerationRequest.brandVoiceContext.
 */
export function getBrandVoiceContext(profile: BrandVoiceProfile): string {
  const lines: string[] = ["Brand voice:"];

  if (profile.toneMarkers.length > 0) {
    lines.push(`- Tone: ${profile.toneMarkers.join(", ")}`);
  }
  if (profile.vocabularyStyle) {
    lines.push(`- Style: ${profile.vocabularyStyle}`);
  }
  if (profile.prohibitedPhrases.length > 0) {
    const quoted = profile.prohibitedPhrases.map(p => `"${p}"`).join(", ");
    lines.push(`- Avoid: ${quoted}`);
  }
  if (profile.preferredCTAs.length > 0) {
    const quoted = profile.preferredCTAs.map(p => `"${p}"`).join(", ");
    lines.push(`- Preferred phrases: ${quoted}`);
  }

  return lines.join("\n");
}
