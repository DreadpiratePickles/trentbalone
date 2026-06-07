import { describe, expect, it } from "vitest";
import { memStore } from "@/lib/mem-store";
import {
  applySocialVoicePolicy,
  getSocialVoicePolicy,
  normalizeSocialVoicePolicyInput,
  upsertSocialVoicePolicy,
  type SocialVoicePolicy,
} from "./voice-policy";

describe("social voice policy", () => {
  it("normalizes tone, hashtag policy, emoji policy, restricted terms, and per-platform guidance", () => {
    const normalized = normalizeSocialVoicePolicyInput({
      companyId: " co_1 ",
      tone: " warm, specific, founder-to-founder ",
      hashtagPolicy: "Use one branded hashtag and one topical hashtag.",
      emojiPolicy: "No more than one emoji per post.",
      restrictedTerms: [" Synergy ", "leverage", "synergy"],
      platformGuidance: {
        x: "Lead with the hook.",
        linkedin: "Add practical founder context.",
        unknown: "ignored",
      },
    });

    expect(normalized).toEqual({
      companyId: "co_1",
      tone: "warm, specific, founder-to-founder",
      hashtagPolicy: "Use one branded hashtag and one topical hashtag.",
      emojiPolicy: "No more than one emoji per post.",
      restrictedTerms: ["Synergy", "leverage"],
      platformGuidance: {
        x: "Lead with the hook.",
        linkedin: "Add practical founder context.",
      },
    });
  });

  it("upserts and fetches one voice policy per company", async () => {
    const first = await upsertSocialVoicePolicy(memStore, {
      companyId: "co_voice_memory",
      tone: "direct and pragmatic",
      hashtagPolicy: "Use no hashtags unless the platform benefits from discovery.",
      emojiPolicy: "Use emoji sparingly.",
      restrictedTerms: ["disrupt"],
      platformGuidance: { x: "Short punchy post.", linkedin: "Practical operator note." },
    });

    const second = await upsertSocialVoicePolicy(memStore, {
      companyId: "co_voice_memory",
      tone: "calm and evidence-led",
      hashtagPolicy: "Use at most two hashtags.",
      emojiPolicy: "No emoji in serious updates.",
      restrictedTerms: ["disrupt", "crushing it"],
      platformGuidance: { x: "One idea only." },
    });
    const fetched = await getSocialVoicePolicy(memStore, "co_voice_memory");

    expect(second.id).toBe(first.id);
    expect(fetched?.tone).toBe("calm and evidence-led");
    expect(fetched?.restrictedTerms).toEqual(["disrupt", "crushing it"]);
    expect(fetched?.platformGuidance).toEqual({ x: "One idea only." });
  });

  it("applies policy guidance with company brand voice context", () => {
    const result = applySocialVoicePolicy({
      content: "Launch notes are ready.",
      platform: "linkedin",
      policy: policy({
        tone: "plainspoken and useful",
        hashtagPolicy: "Use one topical hashtag.",
        emojiPolicy: "Avoid emoji.",
        platformGuidance: { linkedin: "Write like an operator memo." },
      }),
      brandVoiceProfile: {
        toneMarkers: ["conversational", "honest"],
        vocabularyStyle: "Short sentences. Use concrete examples.",
        prohibitedPhrases: ["world-class"],
        preferredCTAs: ["Take the next step"],
        sampleCount: 3,
        confidence: "high",
        derivedAt: "2026-05-29T00:00:00.000Z",
      },
    });

    expect(result.content).toBe("Launch notes are ready.");
    expect(result.guidance).toContain("plainspoken and useful");
    expect(result.guidance).toContain("Use one topical hashtag.");
    expect(result.guidance).toContain("Avoid emoji.");
    expect(result.guidance).toContain("Write like an operator memo.");
    expect(result.guidance).toContain("conversational");
    expect(result.guidance).toContain("Take the next step");
  });

  it("rejects restricted terms from policy and company brand voice", () => {
    expect(() => applySocialVoicePolicy({
      content: "We are here to disrupt the category.",
      platform: "x",
      policy: policy({ restrictedTerms: ["disrupt"] }),
    })).toThrow("Restricted social voice term");

    expect(() => applySocialVoicePolicy({
      content: "This is a world-class operating layer.",
      platform: "linkedin",
      policy: policy(),
      brandVoiceProfile: {
        toneMarkers: [],
        vocabularyStyle: "",
        prohibitedPhrases: ["world-class"],
        preferredCTAs: [],
        sampleCount: 1,
        confidence: "low",
        derivedAt: "2026-05-29T00:00:00.000Z",
      },
    })).toThrow("world-class");
  });
});

function policy(overrides: Partial<SocialVoicePolicy> = {}): SocialVoicePolicy {
  return {
    id: "socvoice_1",
    companyId: "co_1",
    tone: "clear",
    hashtagPolicy: "Use hashtags intentionally.",
    emojiPolicy: "Use emoji only when helpful.",
    restrictedTerms: [],
    platformGuidance: {},
    createdAt: "2026-05-29T00:00:00.000Z",
    updatedAt: "2026-05-29T00:00:00.000Z",
    ...overrides,
  };
}
