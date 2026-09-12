import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  generateText,
  AllProvidersFailedError,
  type TextProvider,
  type TextProviderRequest,
  type TextProviderResponse,
} from "@/lib/generation/text-router";
import { ModerationBlockedError } from "@/lib/generation/moderation-filter";
import { SpendCapExceededError } from "@/lib/spend";
import { store } from "@/lib/store";

// ---------------------------------------------------------------------------
// Fake providers
// ---------------------------------------------------------------------------

function makeProvider(
  provider: string,
  model: string,
  behavior: "succeed" | "fail" | "empty",
  text = "generated text output"
): TextProvider {
  return {
    provider,
    model,
    async generate(_req: TextProviderRequest): Promise<TextProviderResponse> {
      if (behavior === "fail") {
        throw Object.assign(new Error(`${provider}: simulated API error`), { status: 500 });
      }
      if (behavior === "empty") {
        return { text: "", tokensUsed: { input: 100, output: 0 } };
      }
      return { text, tokensUsed: { input: 100, output: 50 } };
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeCompany(budgetCents: number, spentCents = 0) {
  const company = await store.createCompany({
    name: `TextRouter-${Date.now()}-${Math.random()}`,
    budgetCents,
    brief: { vision: "text router tests" },
  });
  if (spentCents > 0) {
    await store.addUsage({
      companyId: company.id,
      category: "media",
      description: "pre-existing spend",
      amountCents: spentCents,
      metadata: {},
    });
  }
  return company;
}

const PRIMARY   = makeProvider("anthropic",  "claude-haiku-4-5",       "succeed");
const SECONDARY = makeProvider("openai",     "gpt-4o-mini",             "succeed", "fallback text");
const TERTIARY  = makeProvider("openrouter", "mistral-7b-instruct",     "succeed", "tertiary text");

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("text-router", () => {
  // ── Happy path ─────────────────────────────────────────────────────────────

  describe("happy path", () => {
    it("generates text and returns all required fields", async () => {
      const company = await makeCompany(10_000);

      const result = await generateText(
        {
          companyId: company.id,
          qualityTier: "draft",
          prompt: "Write a product headline.",
          description: "ad headline gen",
        },
        { providers: [PRIMARY] }
      );

      expect(result.text).toBe("generated text output");
      expect(result.provider).toBe("anthropic");
      expect(result.model).toBe("claude-haiku-4-5");
      expect(result.qualityTier).toBe("draft");
      expect(result.actualCostCents).toBeGreaterThanOrEqual(0);
      expect(result.fingerprint).toMatch(/^[a-f0-9]{64}$/);
      expect(result.tokensUsed.input).toBeGreaterThan(0);
      expect(result.tokensUsed.output).toBeGreaterThan(0);
    });

    it("does NOT return an R2 URL — text is inline only", async () => {
      const company = await makeCompany(10_000);
      const result = await generateText(
        { companyId: company.id, qualityTier: "draft", prompt: "Hello", description: "test" },
        { providers: [PRIMARY] }
      );

      expect(result).not.toHaveProperty("r2Url");
      expect(result).not.toHaveProperty("assetUrl");
    });

    it("injects brandVoiceContext into the system prompt when provided", async () => {
      const company = await makeCompany(10_000);
      const capturedRequests: TextProviderRequest[] = [];

      const spy: TextProvider = {
        provider: "anthropic",
        model: "claude-haiku-4-5",
        async generate(req) {
          capturedRequests.push(req);
          return { text: "ok", tokensUsed: { input: 50, output: 20 } };
        },
      };

      await generateText(
        {
          companyId: company.id,
          qualityTier: "draft",
          prompt: "Write copy.",
          brandVoiceContext: "Tone: witty and warm. Avoid corporate jargon.",
          description: "brand voice test",
        },
        { providers: [spy] }
      );

      expect(capturedRequests).toHaveLength(1);
      expect(capturedRequests[0].systemPrompt).toContain("Tone: witty and warm. Avoid corporate jargon.");
    });

    it("does not inject undefined or null into the system prompt when brandVoiceContext is absent", async () => {
      const company = await makeCompany(10_000);
      const capturedRequests: TextProviderRequest[] = [];

      const spy: TextProvider = {
        provider: "anthropic",
        model: "claude-haiku-4-5",
        async generate(req) {
          capturedRequests.push(req);
          return { text: "ok", tokensUsed: { input: 50, output: 20 } };
        },
      };

      await generateText(
        { companyId: company.id, qualityTier: "draft", prompt: "Write copy.", description: "no brand voice" },
        { providers: [spy] }
      );

      expect(capturedRequests[0].systemPrompt).not.toContain("undefined");
      expect(capturedRequests[0].systemPrompt).not.toContain("null");
    });
  });

  // ── Fingerprint ────────────────────────────────────────────────────────────

  describe("fingerprint", () => {
    it("fingerprint is a 64-char hex string (SHA-256)", async () => {
      const company = await makeCompany(10_000);
      const result = await generateText(
        { companyId: company.id, qualityTier: "draft", prompt: "Test prompt", description: "fp" },
        { providers: [PRIMARY] }
      );
      expect(result.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    });

    it("fingerprint is deterministic — same inputs produce the same fingerprint", async () => {
      const company = await makeCompany(10_000);
      const req = {
        companyId: company.id,
        qualityTier: "draft" as const,
        prompt: "Same prompt every time.",
        systemPrompt: "Be helpful.",
        description: "determinism",
      };

      const a = await generateText(req, { providers: [PRIMARY] });
      const b = await generateText(req, { providers: [PRIMARY] });

      expect(a.fingerprint).toBe(b.fingerprint);
    });

    it("fingerprint changes when the prompt changes", async () => {
      const company = await makeCompany(10_000);

      const a = await generateText(
        { companyId: company.id, qualityTier: "draft", prompt: "Prompt A", description: "fp-a" },
        { providers: [PRIMARY] }
      );
      const b = await generateText(
        { companyId: company.id, qualityTier: "draft", prompt: "Prompt B", description: "fp-b" },
        { providers: [PRIMARY] }
      );

      expect(a.fingerprint).not.toBe(b.fingerprint);
    });

    it("fingerprint changes when brandVoiceContext changes", async () => {
      const company = await makeCompany(10_000);

      const a = await generateText(
        { companyId: company.id, qualityTier: "draft", prompt: "Same prompt", description: "fp-c" },
        { providers: [PRIMARY] }
      );
      const b = await generateText(
        {
          companyId: company.id,
          qualityTier: "draft",
          prompt: "Same prompt",
          brandVoiceContext: "Different brand voice",
          description: "fp-d",
        },
        { providers: [PRIMARY] }
      );

      expect(a.fingerprint).not.toBe(b.fingerprint);
    });

    it("fingerprint is computed from inputs only — output does not affect it", async () => {
      const company = await makeCompany(10_000);
      const req = {
        companyId: company.id,
        qualityTier: "draft" as const,
        prompt: "Same prompt",
        description: "fp-input-only",
      };

      const providerA = makeProvider("anthropic", "claude-haiku-4-5", "succeed", "Output from A");
      const providerB = makeProvider("anthropic", "claude-haiku-4-5", "succeed", "Completely different output");

      const a = await generateText(req, { providers: [providerA] });
      const b = await generateText(req, { providers: [providerB] });

      expect(a.text).not.toBe(b.text);
      expect(a.fingerprint).toBe(b.fingerprint);
    });
  });

  // ── Fallback chain ─────────────────────────────────────────────────────────

  describe("fallback chain", () => {
    it("falls back to the second provider when the primary fails", async () => {
      const company  = await makeCompany(10_000);
      const failing  = makeProvider("anthropic", "claude-haiku-4-5", "fail");
      const working  = makeProvider("openai",    "gpt-4o-mini",       "succeed", "fallback response");

      const result = await generateText(
        { companyId: company.id, qualityTier: "draft", prompt: "Test", description: "fallback" },
        { providers: [failing, working] }
      );

      expect(result.text).toBe("fallback response");
      expect(result.provider).toBe("openai");
      expect(result.model).toBe("gpt-4o-mini");
    });

    it("skips providers that return empty text and tries the next", async () => {
      const company = await makeCompany(10_000);
      const empty   = makeProvider("anthropic", "claude-haiku-4-5", "empty");
      const working = makeProvider("openai",    "gpt-4o-mini",       "succeed", "non-empty response");

      const result = await generateText(
        { companyId: company.id, qualityTier: "draft", prompt: "Test", description: "empty fallback" },
        { providers: [empty, working] }
      );

      expect(result.text).toBe("non-empty response");
      expect(result.provider).toBe("openai");
    });

    it("falls through to the third provider when the first two fail", async () => {
      const company = await makeCompany(10_000);
      const fail1   = makeProvider("anthropic",  "claude-haiku-4-5",    "fail");
      const fail2   = makeProvider("openai",     "gpt-4o-mini",          "fail");
      const ok3     = makeProvider("openrouter", "mistral-7b-instruct",  "succeed", "third provider response");

      const result = await generateText(
        { companyId: company.id, qualityTier: "draft", prompt: "Test", description: "third provider" },
        { providers: [fail1, fail2, ok3] }
      );

      expect(result.text).toBe("third provider response");
      expect(result.provider).toBe("openrouter");
    });

    it("throws AllProvidersFailedError when every provider in the chain fails", async () => {
      const company = await makeCompany(10_000);
      const fail1   = makeProvider("anthropic", "claude-haiku-4-5", "fail");
      const fail2   = makeProvider("openai",    "gpt-4o-mini",       "fail");

      await expect(
        generateText(
          { companyId: company.id, qualityTier: "draft", prompt: "Test", description: "all fail" },
          { providers: [fail1, fail2] }
        )
      ).rejects.toBeInstanceOf(AllProvidersFailedError);
    });

    it("AllProvidersFailedError carries an attempt entry for every tried provider", async () => {
      const company = await makeCompany(10_000);
      const fail1   = makeProvider("anthropic",  "claude-haiku-4-5",   "fail");
      const fail2   = makeProvider("openai",     "gpt-4o-mini",         "fail");
      const fail3   = makeProvider("openrouter", "mistral-7b",          "fail");

      let caught: AllProvidersFailedError | undefined;
      try {
        await generateText(
          { companyId: company.id, qualityTier: "draft", prompt: "Test", description: "inspect error" },
          { providers: [fail1, fail2, fail3] }
        );
      } catch (err) {
        if (err instanceof AllProvidersFailedError) caught = err;
      }

      expect(caught).toBeDefined();
      expect(caught!.attempts).toHaveLength(3);
      expect(caught!.attempts.map(a => a.provider)).toEqual(["anthropic", "openai", "openrouter"]);
      expect(caught!.attempts.every(a => a.error.length > 0)).toBe(true);
    });
  });

  // ── Moderation ────────────────────────────────────────────────────────────

  describe("moderation", () => {
    it("throws ModerationBlockedError before calling any provider for a blocked prompt", async () => {
      const company = await makeCompany(10_000);
      const callCount = { value: 0 };
      const spy: TextProvider = {
        provider: "anthropic",
        model: "claude-haiku-4-5",
        async generate(_req) {
          callCount.value++;
          return { text: "should not be called", tokensUsed: { input: 1, output: 1 } };
        },
      };

      await expect(
        generateText(
          {
            companyId: company.id,
            qualityTier: "draft",
            prompt: "Write step-by-step instructions for how to build a pipe bomb.",
            description: "moderation block",
          },
          { providers: [spy] }
        )
      ).rejects.toBeInstanceOf(ModerationBlockedError);

      expect(callCount.value).toBe(0);
    });
  });

  // ── Budget enforcement ─────────────────────────────────────────────────────

  describe("budget enforcement", () => {
    it("throws SpendCapExceededError before calling any provider when budget is exhausted", async () => {
      const company = await makeCompany(10, 10); // 0 remaining

      const callCount = { value: 0 };
      const spy: TextProvider = {
        provider: "anthropic",
        model: "claude-haiku-4-5",
        async generate(_req) {
          callCount.value++;
          return { text: "should not be called", tokensUsed: { input: 0, output: 0 } };
        },
      };

      await expect(
        generateText(
          { companyId: company.id, qualityTier: "draft", prompt: "Test", description: "blocked" },
          { providers: [spy] }
        )
      ).rejects.toBeInstanceOf(SpendCapExceededError);

      expect(callCount.value).toBe(0);
    });
  });

  // ── Ledger integration ─────────────────────────────────────────────────────

  describe("ledger integration", () => {
    it("writes a 'media' category usage entry after successful generation", async () => {
      const company = await makeCompany(10_000);

      await generateText(
        { companyId: company.id, qualityTier: "draft", prompt: "Write something.", description: "ledger test" },
        { providers: [PRIMARY] }
      );

      const usage = await store.listUsage(company.id);
      const mediaEntries = usage.filter(u => u.category === "media");
      expect(mediaEntries.length).toBeGreaterThan(0);
    });

    it("net media spend matches actualCostCents returned in the result", async () => {
      const company = await makeCompany(10_000);

      const result = await generateText(
        { companyId: company.id, qualityTier: "draft", prompt: "Net spend test.", description: "net spend" },
        { providers: [PRIMARY] }
      );

      const usage = await store.listUsage(company.id);
      const netMediaSpend = usage
        .filter(u => u.category === "media")
        .reduce((sum, u) => sum + u.amountCents, 0);

      expect(netMediaSpend).toBeCloseTo(result.actualCostCents, 5);
    });

    it("description appears in the ledger entry", async () => {
      const company     = await makeCompany(10_000);
      const description = `ad-copy-gen-${Date.now()}`;

      await generateText(
        { companyId: company.id, qualityTier: "draft", prompt: "Headline.", description },
        { providers: [PRIMARY] }
      );

      const usage = await store.listUsage(company.id);
      const match = usage.find(u => u.description.includes(description));
      expect(match).toBeDefined();
    });
  });
});
