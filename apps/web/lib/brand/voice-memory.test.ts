import { describe, expect, it } from "vitest";
import {
  deriveVoiceProfile,
  getVoiceProfile,
  getBrandVoiceContext,
  InsufficientSamplesError,
  type BrandVoiceProfile,
} from "@/lib/brand/voice-memory";
import type { TextProvider } from "@/lib/generation/text-router";
import { store } from "@/lib/store";

// ---------------------------------------------------------------------------
// Fake text provider
// ---------------------------------------------------------------------------

const FAKE_PROFILE_JSON = JSON.stringify({
  toneMarkers: ["conversational", "direct", "witty"],
  vocabularyStyle: "Short sentences. Uses contractions. Avoids jargon.",
  prohibitedPhrases: ["leverage", "synergy", "circle back"],
  preferredCTAs: ["Let's go", "Ready?"],
});

function makeDerivationProvider(responseText = FAKE_PROFILE_JSON): TextProvider {
  return {
    provider: "anthropic",
    model: "claude-haiku-4-5",
    async generate(_req) {
      return { text: responseText, tokensUsed: { input: 200, output: 100 } };
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SAMPLES_3 = [
  "We built this because we were sick of bloated tools that get in the way.",
  "Let's ship it. No more waiting for perfect.",
  "Your users don't care about your architecture. They care about results.",
];

const SAMPLE_1  = ["Here's the thing — most startups overthink it."];
const SAMPLES_2 = SAMPLES_3.slice(0, 2);

async function makeCompany() {
  return store.createCompany({
    name: `VoiceMemory-${Date.now()}-${Math.random()}`,
    budgetCents: 10_000,
    brief: { vision: "voice memory tests" },
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("voice-memory", () => {
  // ── Derivation ─────────────────────────────────────────────────────────────

  describe("deriveVoiceProfile", () => {
    it("derives a profile with toneMarkers, vocabularyStyle, prohibitedPhrases, and preferredCTAs", async () => {
      const company = await makeCompany();

      const profile = await deriveVoiceProfile(company.id, SAMPLES_3, {
        textProviders: [makeDerivationProvider()],
      });

      expect(profile.toneMarkers).toEqual(["conversational", "direct", "witty"]);
      expect(profile.vocabularyStyle).toContain("contractions");
      expect(profile.prohibitedPhrases).toContain("leverage");
      expect(profile.preferredCTAs).toContain("Let's go");
    });

    it("records sampleCount matching the number of samples provided", async () => {
      const company = await makeCompany();

      const profile = await deriveVoiceProfile(company.id, SAMPLES_3, {
        textProviders: [makeDerivationProvider()],
      });

      expect(profile.sampleCount).toBe(3);
    });

    it("records a derivedAt ISO timestamp", async () => {
      const company = await makeCompany();

      const profile = await deriveVoiceProfile(company.id, SAMPLES_3, {
        textProviders: [makeDerivationProvider()],
      });

      expect(() => new Date(profile.derivedAt)).not.toThrow();
      expect(profile.derivedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it("sets confidence to 'high' with 3 or more samples", async () => {
      const company = await makeCompany();

      const profile = await deriveVoiceProfile(company.id, SAMPLES_3, {
        textProviders: [makeDerivationProvider()],
      });

      expect(profile.confidence).toBe("high");
    });

    it("sets confidence to 'medium' with exactly 2 samples", async () => {
      const company = await makeCompany();

      const profile = await deriveVoiceProfile(company.id, SAMPLES_2, {
        textProviders: [makeDerivationProvider()],
      });

      expect(profile.confidence).toBe("medium");
    });

    it("sets confidence to 'low' with exactly 1 sample", async () => {
      const company = await makeCompany();

      const profile = await deriveVoiceProfile(company.id, SAMPLE_1, {
        textProviders: [makeDerivationProvider()],
      });

      expect(profile.confidence).toBe("low");
    });

    it("throws InsufficientSamplesError when samples array is empty", async () => {
      const company = await makeCompany();

      await expect(
        deriveVoiceProfile(company.id, [], { textProviders: [makeDerivationProvider()] })
      ).rejects.toBeInstanceOf(InsufficientSamplesError);
    });

    it("returns a fallback profile (no throw) when the LLM returns malformed JSON", async () => {
      const company = await makeCompany();
      const badProvider = makeDerivationProvider("This is not JSON at all.");

      const profile = await deriveVoiceProfile(company.id, SAMPLES_3, {
        textProviders: [badProvider],
      });

      expect(profile).toBeDefined();
      expect(profile.confidence).toBe("low");
      expect(Array.isArray(profile.toneMarkers)).toBe(true);
      expect(typeof profile.vocabularyStyle).toBe("string");
    });

    it("persists the profile — getVoiceProfile returns it after derivation", async () => {
      const company = await makeCompany();
      await deriveVoiceProfile(company.id, SAMPLES_3, {
        textProviders: [makeDerivationProvider()],
      });

      const loaded = await getVoiceProfile(company.id);

      expect(loaded).not.toBeNull();
      expect(loaded!.toneMarkers).toEqual(["conversational", "direct", "witty"]);
    });

    it("overwrites an existing profile when derived again (latest wins)", async () => {
      const company = await makeCompany();

      const updatedJson = JSON.stringify({
        toneMarkers: ["bold", "provocative"],
        vocabularyStyle: "Long-form, detail-oriented prose.",
        prohibitedPhrases: ["just", "simply"],
        preferredCTAs: ["Dive in"],
      });

      await deriveVoiceProfile(company.id, SAMPLES_3, {
        textProviders: [makeDerivationProvider()],
      });
      await deriveVoiceProfile(company.id, SAMPLES_3, {
        textProviders: [makeDerivationProvider(updatedJson)],
      });

      const loaded = await getVoiceProfile(company.id);
      expect(loaded!.toneMarkers).toEqual(["bold", "provocative"]);
    });

    it("profiles are company-isolated — company A's profile is not visible to company B", async () => {
      const companyA = await makeCompany();
      const companyB = await makeCompany();

      await deriveVoiceProfile(companyA.id, SAMPLES_3, {
        textProviders: [makeDerivationProvider()],
      });

      const profileB = await getVoiceProfile(companyB.id);
      expect(profileB).toBeNull();
    });
  });

  // ── getVoiceProfile ────────────────────────────────────────────────────────

  describe("getVoiceProfile", () => {
    it("returns null when no profile has been derived for the company", async () => {
      const company = await makeCompany();
      const profile = await getVoiceProfile(company.id);
      expect(profile).toBeNull();
    });
  });

  // ── getBrandVoiceContext ───────────────────────────────────────────────────

  describe("getBrandVoiceContext", () => {
    const PROFILE: BrandVoiceProfile = {
      toneMarkers:      ["conversational", "witty"],
      vocabularyStyle:  "Short sentences. Contractions welcome.",
      prohibitedPhrases: ["leverage", "synergy"],
      preferredCTAs:    ["Let's go"],
      sampleCount:      3,
      confidence:       "high",
      derivedAt:        "2026-01-01T00:00:00.000Z",
    };

    it("returns a non-empty string", () => {
      expect(getBrandVoiceContext(PROFILE).length).toBeGreaterThan(0);
    });

    it("includes tone markers in the output", () => {
      const ctx = getBrandVoiceContext(PROFILE);
      expect(ctx).toContain("conversational");
      expect(ctx).toContain("witty");
    });

    it("includes prohibited phrases in the output", () => {
      const ctx = getBrandVoiceContext(PROFILE);
      expect(ctx).toContain("leverage");
      expect(ctx).toContain("synergy");
    });

    it("includes preferred CTAs in the output", () => {
      const ctx = getBrandVoiceContext(PROFILE);
      expect(ctx).toContain("Let's go");
    });

    it("includes vocabulary style in the output", () => {
      const ctx = getBrandVoiceContext(PROFILE);
      expect(ctx).toContain("Short sentences");
    });

    it("is a pure function — same profile always produces the same output", () => {
      expect(getBrandVoiceContext(PROFILE)).toBe(getBrandVoiceContext(PROFILE));
    });
  });
});
