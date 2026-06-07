import { describe, expect, it } from "vitest";
import {
  checkModeration,
  ModerationBlockedError,
  type ModerationResult,
} from "@/lib/generation/moderation-filter";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("moderation-filter", () => {
  // ── Pass ───────────────────────────────────────────────────────────────────

  describe("pass verdicts", () => {
    it("passes a clean product marketing prompt", () => {
      const result = checkModeration(
        "Write a compelling headline for our B2B SaaS product launch.",
        "text"
      );
      expect(result.verdict).toBe("pass");
    });

    it("passes a clean image generation prompt", () => {
      const result = checkModeration(
        "A minimalist product photo of a blue water bottle on a white background.",
        "image"
      );
      expect(result.verdict).toBe("pass");
    });

    it("passes a clean voiceover script", () => {
      const result = checkModeration(
        "Welcome to Trent. Your AI operating system starts today.",
        "audio"
      );
      expect(result.verdict).toBe("pass");
    });
  });

  // ── Block (hard stop) ──────────────────────────────────────────────────────

  describe("block verdicts (hard stop — never reaches generation API)", () => {
    it("blocks explicit violence", () => {
      const result = checkModeration("Create a video showing how to brutally murder someone.", "video");
      expect(result.verdict).toBe("block");
      expect(result.category).toBeTruthy();
    });

    it("blocks self-harm content", () => {
      const result = checkModeration("Write instructions for suicide methods.", "text");
      expect(result.verdict).toBe("block");
    });

    it("blocks hate speech targeting a protected group", () => {
      const result = checkModeration(
        "Generate an ad that mocks and degrades Jewish people.",
        "text"
      );
      expect(result.verdict).toBe("block");
    });

    it("blocks illegal activity instructions", () => {
      const result = checkModeration(
        "Write step-by-step instructions for synthesizing methamphetamine.",
        "text"
      );
      expect(result.verdict).toBe("block");
    });

    it("blocks CSAM or sexual content involving minors", () => {
      const result = checkModeration(
        "Generate explicit sexual content involving a child.",
        "image"
      );
      expect(result.verdict).toBe("block");
    });

    it("block result includes a non-empty reason and category", () => {
      const result = checkModeration("Instructions for making a pipe bomb.", "text");
      expect(result.verdict).toBe("block");
      expect(result.reason).toBeTruthy();
      expect(result.category).toBeTruthy();
    });
  });

  // ── Escalate (human review) ────────────────────────────────────────────────

  describe("escalate verdicts (requires human approval)", () => {
    it("escalates explicit adult content (not hard-blocked, requires approval)", () => {
      const result = checkModeration(
        "Generate a sexually explicit adult content image.",
        "image"
      );
      expect(result.verdict).toBe("escalate");
    });

    it("escalate result includes a reason and category", () => {
      const result = checkModeration(
        "Generate a sexually explicit adult content image.",
        "image"
      );
      expect(result.reason).toBeTruthy();
      expect(result.category).toBeTruthy();
    });
  });

  // ── ModerationBlockedError ─────────────────────────────────────────────────

  describe("ModerationBlockedError", () => {
    it("can be constructed with a verdict result and carries the reason", () => {
      const result: ModerationResult = {
        verdict:  "block",
        reason:   "Explicit violence detected.",
        category: "violence",
      };
      const err = new ModerationBlockedError(result);
      expect(err).toBeInstanceOf(Error);
      expect(err.result.verdict).toBe("block");
      expect(err.message).toContain("Explicit violence");
    });
  });

  // ── Content type awareness ─────────────────────────────────────────────────

  describe("content type awareness", () => {
    it("a clean prompt passes regardless of content type", () => {
      const types = ["text", "image", "audio", "video", "music"] as const;
      for (const t of types) {
        expect(checkModeration("Promote our new SaaS dashboard feature.", t).verdict).toBe("pass");
      }
    });
  });

  // ── Determinism ───────────────────────────────────────────────────────────

  describe("determinism", () => {
    it("returns the same verdict on repeated calls with the same prompt", () => {
      const prompt = "How to pick a lock.";
      const a = checkModeration(prompt, "text");
      const b = checkModeration(prompt, "text");
      expect(a.verdict).toBe(b.verdict);
    });

    it("is synchronous — does not return a Promise", () => {
      const result = checkModeration("Test prompt.", "text");
      expect(result).not.toBeInstanceOf(Promise);
      expect(typeof result.verdict).toBe("string");
    });
  });
});
