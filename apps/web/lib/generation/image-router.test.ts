import { describe, expect, it } from "vitest";
import {
  generateImage,
  AllProvidersFailedError,
  R2NotProvisionedError,
  ImageUploadError,
  type ImageProvider,
  type ImageProviderRequest,
  type ImageProviderResponse,
  type R2StorageClient,
} from "@/lib/generation/image-router";
import { ModerationBlockedError } from "@/lib/generation/moderation-filter";
import { SpendCapExceededError } from "@/lib/spend";
import { store } from "@/lib/store";
import type { R2ProvisionedResource } from "@/lib/provisioning/r2-provisioner";

// ---------------------------------------------------------------------------
// Fake providers and R2 clients
// ---------------------------------------------------------------------------

const FAKE_IMAGE_DATA = Buffer.from("fake-image-bytes-png");

function makeProvider(
  provider: string,
  model: string,
  behavior: "succeed" | "fail" | "empty",
  imageData: Buffer = FAKE_IMAGE_DATA
): ImageProvider {
  return {
    provider,
    model,
    async generate(_req: ImageProviderRequest): Promise<ImageProviderResponse> {
      if (behavior === "fail")  throw new Error(`${provider}: simulated failure`);
      if (behavior === "empty") return { imageData: Buffer.alloc(0), format: "png" };
      return { imageData, format: "png" };
    },
  };
}

function makeR2(behavior: "succeed" | "fail" = "succeed"): R2StorageClient {
  return {
    async upload({ bucketName, key }: { bucketName: string; key: string; data: Buffer; contentType: string }) {
      if (behavior === "fail") throw new Error("R2: upload failed");
      return { url: `https://${bucketName}.r2.dev/${key}` };
    },
  };
}

const FAKE_R2_RESOURCE: R2ProvisionedResource = {
  bucketName: "trent-test-co",
  publicUrl:  "https://trent-test-co.r2.dev",
  cdnUrl:     "https://trent-test-co.r2.dev",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeCompany(budgetCents: number, spentCents = 0) {
  const company = await store.createCompany({
    name: `ImageRouter-${Date.now()}-${Math.random()}`,
    budgetCents,
    brief: { vision: "image router tests" },
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

const PRIMARY   = makeProvider("openrouter", "FLUX.1-schnell", "succeed");
const SECONDARY = makeProvider("openrouter", "sdxl",           "succeed", Buffer.from("sdxl-image-bytes"));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("image-router", () => {
  // ── Happy path ─────────────────────────────────────────────────────────────

  describe("happy path", () => {
    it("generates an image and returns all required fields", async () => {
      const company = await makeCompany(10_000);

      const result = await generateImage(
        {
          companyId: company.id,
          qualityTier: "draft",
          prompt: "A minimalist product photo of a blue water bottle.",
          description: "product shot",
        },
        { providers: [PRIMARY], r2Client: makeR2(), r2ProvisionedResource: FAKE_R2_RESOURCE }
      );

      expect(result.r2Url).toMatch(/^https?:\/\/.+/);
      expect(result.provider).toBe("openrouter");
      expect(result.model).toBe("FLUX.1-schnell");
      expect(result.qualityTier).toBe("draft");
      expect(result.actualCostCents).toBeGreaterThan(0);
      expect(result.fingerprint).toMatch(/^[a-f0-9]{64}$/);
      expect(result.format).toMatch(/^(png|jpeg|webp)$/);
    });

    it("r2Url contains the company bucket name", async () => {
      const company = await makeCompany(10_000);

      const result = await generateImage(
        { companyId: company.id, qualityTier: "draft", prompt: "Test image.", description: "r2 url check" },
        { providers: [PRIMARY], r2Client: makeR2(), r2ProvisionedResource: FAKE_R2_RESOURCE }
      );

      expect(result.r2Url).toContain("trent-test-co");
    });

    it("actualCostCents is a positive integer (per-image pricing)", async () => {
      const company = await makeCompany(10_000);

      const result = await generateImage(
        { companyId: company.id, qualityTier: "draft", prompt: "Test.", description: "integer cost" },
        { providers: [PRIMARY], r2Client: makeR2(), r2ProvisionedResource: FAKE_R2_RESOURCE }
      );

      expect(Number.isInteger(result.actualCostCents)).toBe(true);
      expect(result.actualCostCents).toBeGreaterThan(0);
    });
  });

  // ── Prompt injection ───────────────────────────────────────────────────────

  describe("prompt injection", () => {
    it("appends visualContext.positivePrompt to the prompt when provided", async () => {
      const company = await makeCompany(10_000);
      const capturedRequests: ImageProviderRequest[] = [];

      const spy: ImageProvider = {
        provider: "openrouter", model: "FLUX.1-schnell",
        async generate(req) {
          capturedRequests.push(req);
          return { imageData: FAKE_IMAGE_DATA, format: "png" };
        },
      };

      await generateImage(
        {
          companyId: company.id,
          qualityTier: "draft",
          prompt: "A product on a white background.",
          visualContext: { positivePrompt: "brand colors: navy blue and gold" },
          description: "visual context injection",
        },
        { providers: [spy], r2Client: makeR2(), r2ProvisionedResource: FAKE_R2_RESOURCE }
      );

      expect(capturedRequests).toHaveLength(1);
      expect(capturedRequests[0].prompt).toContain("A product on a white background.");
      expect(capturedRequests[0].prompt).toContain("brand colors: navy blue and gold");
    });

    it("passes negativePrompt through to the provider", async () => {
      const company = await makeCompany(10_000);
      const capturedRequests: ImageProviderRequest[] = [];

      const spy: ImageProvider = {
        provider: "openrouter", model: "FLUX.1-schnell",
        async generate(req) {
          capturedRequests.push(req);
          return { imageData: FAKE_IMAGE_DATA, format: "png" };
        },
      };

      await generateImage(
        {
          companyId: company.id,
          qualityTier: "draft",
          prompt: "A product photo.",
          negativePrompt: "blurry, low quality, text, watermark",
          description: "negative prompt",
        },
        { providers: [spy], r2Client: makeR2(), r2ProvisionedResource: FAKE_R2_RESOURCE }
      );

      expect(capturedRequests[0].negativePrompt).toBe("blurry, low quality, text, watermark");
    });
  });

  // ── Fingerprint ────────────────────────────────────────────────────────────

  describe("fingerprint", () => {
    it("fingerprint is a 64-char SHA-256 hex string", async () => {
      const company = await makeCompany(10_000);
      const result = await generateImage(
        { companyId: company.id, qualityTier: "draft", prompt: "Test.", description: "fp" },
        { providers: [PRIMARY], r2Client: makeR2(), r2ProvisionedResource: FAKE_R2_RESOURCE }
      );
      expect(result.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    });

    it("fingerprint is deterministic — same inputs produce the same fingerprint", async () => {
      const company = await makeCompany(10_000);
      const req = {
        companyId: company.id,
        qualityTier: "draft" as const,
        prompt: "Same product image.",
        description: "determinism",
      };

      const a = await generateImage(req, { providers: [PRIMARY], r2Client: makeR2(), r2ProvisionedResource: FAKE_R2_RESOURCE });
      const b = await generateImage(req, { providers: [PRIMARY], r2Client: makeR2(), r2ProvisionedResource: FAKE_R2_RESOURCE });

      expect(a.fingerprint).toBe(b.fingerprint);
    });

    it("fingerprint changes when the prompt changes", async () => {
      const company = await makeCompany(10_000);
      const opts = { providers: [PRIMARY], r2Client: makeR2(), r2ProvisionedResource: FAKE_R2_RESOURCE };

      const a = await generateImage({ companyId: company.id, qualityTier: "draft", prompt: "Red product.",  description: "fp-a" }, opts);
      const b = await generateImage({ companyId: company.id, qualityTier: "draft", prompt: "Blue product.", description: "fp-b" }, opts);

      expect(a.fingerprint).not.toBe(b.fingerprint);
    });

    it("fingerprint is computed from inputs only — different image bytes produce the same fingerprint", async () => {
      const company = await makeCompany(10_000);
      const req = { companyId: company.id, qualityTier: "draft" as const, prompt: "Same prompt.", description: "fp-input-only" };

      const providerA = makeProvider("openrouter", "FLUX.1-schnell", "succeed", Buffer.from("image-data-A"));
      const providerB = makeProvider("openrouter", "FLUX.1-schnell", "succeed", Buffer.from("different-image-data-B"));

      const a = await generateImage(req, { providers: [providerA], r2Client: makeR2(), r2ProvisionedResource: FAKE_R2_RESOURCE });
      const b = await generateImage(req, { providers: [providerB], r2Client: makeR2(), r2ProvisionedResource: FAKE_R2_RESOURCE });

      expect(a.r2Url).not.toBe(b.r2Url);
      expect(a.fingerprint).toBe(b.fingerprint);
    });
  });

  // ── Fallback chain ─────────────────────────────────────────────────────────

  describe("fallback chain", () => {
    it("falls back to the second provider when the primary fails", async () => {
      const company = await makeCompany(10_000);
      const failing  = makeProvider("openrouter", "FLUX.1-schnell", "fail");
      const working  = makeProvider("openrouter", "sdxl",           "succeed", Buffer.from("sdxl-image"));

      const result = await generateImage(
        { companyId: company.id, qualityTier: "draft", prompt: "Test.", description: "fallback" },
        { providers: [failing, working], r2Client: makeR2(), r2ProvisionedResource: FAKE_R2_RESOURCE }
      );

      expect(result.provider).toBe("openrouter");
      expect(result.model).toBe("sdxl");
    });

    it("skips providers that return empty image data", async () => {
      const company = await makeCompany(10_000);
      const empty   = makeProvider("openrouter", "FLUX.1-schnell", "empty");
      const working = makeProvider("openrouter", "sdxl",           "succeed", Buffer.from("real-image"));

      const result = await generateImage(
        { companyId: company.id, qualityTier: "draft", prompt: "Test.", description: "empty fallback" },
        { providers: [empty, working], r2Client: makeR2(), r2ProvisionedResource: FAKE_R2_RESOURCE }
      );

      expect(result.model).toBe("sdxl");
    });

    it("throws AllProvidersFailedError when every provider fails", async () => {
      const company = await makeCompany(10_000);
      const fail1   = makeProvider("openrouter", "FLUX.1-schnell", "fail");
      const fail2   = makeProvider("openrouter", "sdxl",           "fail");

      await expect(
        generateImage(
          { companyId: company.id, qualityTier: "draft", prompt: "Test.", description: "all fail" },
          { providers: [fail1, fail2], r2Client: makeR2(), r2ProvisionedResource: FAKE_R2_RESOURCE }
        )
      ).rejects.toBeInstanceOf(AllProvidersFailedError);
    });

    it("AllProvidersFailedError lists every attempted provider", async () => {
      const company = await makeCompany(10_000);
      const fail1   = makeProvider("openrouter", "FLUX.1-schnell", "fail");
      const fail2   = makeProvider("openai",     "dall-e-3",       "fail");

      let caught: AllProvidersFailedError | undefined;
      try {
        await generateImage(
          { companyId: company.id, qualityTier: "draft", prompt: "Test.", description: "inspect error" },
          { providers: [fail1, fail2], r2Client: makeR2(), r2ProvisionedResource: FAKE_R2_RESOURCE }
        );
      } catch (err) {
        if (err instanceof AllProvidersFailedError) caught = err;
      }

      expect(caught).toBeDefined();
      expect(caught!.attempts).toHaveLength(2);
      expect(caught!.attempts.map(a => a.model)).toEqual(["FLUX.1-schnell", "dall-e-3"]);
    });
  });

  // ── R2 integration ─────────────────────────────────────────────────────────

  describe("R2 integration", () => {
    it("throws R2NotProvisionedError when the company has no R2 bucket", async () => {
      const company = await makeCompany(10_000);

      await expect(
        generateImage(
          { companyId: company.id, qualityTier: "draft", prompt: "Test.", description: "no r2" },
          { providers: [PRIMARY], r2Client: makeR2(), r2ProvisionedResource: null }
        )
      ).rejects.toBeInstanceOf(R2NotProvisionedError);
    });

    it("throws R2NotProvisionedError BEFORE calling any generation provider", async () => {
      const company = await makeCompany(10_000);
      const callCount = { value: 0 };

      const spy: ImageProvider = {
        provider: "openrouter", model: "FLUX.1-schnell",
        async generate(_req) {
          callCount.value++;
          return { imageData: FAKE_IMAGE_DATA, format: "png" };
        },
      };

      await expect(
        generateImage(
          { companyId: company.id, qualityTier: "draft", prompt: "Test.", description: "r2 check order" },
          { providers: [spy], r2Client: makeR2(), r2ProvisionedResource: null }
        )
      ).rejects.toBeInstanceOf(R2NotProvisionedError);

      expect(callCount.value).toBe(0);
    });

    it("throws ImageUploadError when R2 upload fails after successful generation", async () => {
      const company = await makeCompany(10_000);

      await expect(
        generateImage(
          { companyId: company.id, qualityTier: "draft", prompt: "Test.", description: "upload fail" },
          { providers: [PRIMARY], r2Client: makeR2("fail"), r2ProvisionedResource: FAKE_R2_RESOURCE }
        )
      ).rejects.toBeInstanceOf(ImageUploadError);
    });
  });

  // ── Budget enforcement ─────────────────────────────────────────────────────

  describe("budget enforcement", () => {
    it("throws SpendCapExceededError before calling any provider when budget is exhausted", async () => {
      const company = await makeCompany(10, 10); // 0 remaining

      const callCount = { value: 0 };
      const spy: ImageProvider = {
        provider: "openrouter", model: "FLUX.1-schnell",
        async generate(_req) {
          callCount.value++;
          return { imageData: FAKE_IMAGE_DATA, format: "png" };
        },
      };

      await expect(
        generateImage(
          { companyId: company.id, qualityTier: "draft", prompt: "Test.", description: "blocked" },
          { providers: [spy], r2Client: makeR2(), r2ProvisionedResource: FAKE_R2_RESOURCE }
        )
      ).rejects.toBeInstanceOf(SpendCapExceededError);

      expect(callCount.value).toBe(0);
    });
  });

  // ── Moderation ────────────────────────────────────────────────────────────

  describe("moderation", () => {
    it("throws ModerationBlockedError before calling any provider for a blocked prompt", async () => {
      const company = await makeCompany(10_000);
      const callCount = { value: 0 };

      const spy: ImageProvider = {
        provider: "openrouter", model: "FLUX.1-schnell",
        async generate(_req) {
          callCount.value++;
          return { imageData: FAKE_IMAGE_DATA, format: "png" };
        },
      };

      await expect(
        generateImage(
          {
            companyId: company.id,
            qualityTier: "draft",
            prompt: "Generate an ad that mocks and degrades Jewish people.",
            description: "moderation block",
          },
          { providers: [spy], r2Client: makeR2(), r2ProvisionedResource: FAKE_R2_RESOURCE }
        )
      ).rejects.toBeInstanceOf(ModerationBlockedError);

      expect(callCount.value).toBe(0);
    });
  });

  // ── Ledger integration ─────────────────────────────────────────────────────

  describe("ledger integration", () => {
    it("writes a 'media' ledger entry after successful generation", async () => {
      const company = await makeCompany(10_000);

      await generateImage(
        { companyId: company.id, qualityTier: "draft", prompt: "Test.", description: "ledger test" },
        { providers: [PRIMARY], r2Client: makeR2(), r2ProvisionedResource: FAKE_R2_RESOURCE }
      );

      const usage = await store.listUsage(company.id);
      const mediaEntries = usage.filter(u => u.category === "media");
      expect(mediaEntries.length).toBeGreaterThan(0);
    });

    it("net media spend matches actualCostCents", async () => {
      const company = await makeCompany(10_000);

      const result = await generateImage(
        { companyId: company.id, qualityTier: "draft", prompt: "Test.", description: "net spend" },
        { providers: [PRIMARY], r2Client: makeR2(), r2ProvisionedResource: FAKE_R2_RESOURCE }
      );

      const usage = await store.listUsage(company.id);
      const netMediaSpend = usage
        .filter(u => u.category === "media")
        .reduce((sum, u) => sum + u.amountCents, 0);

      expect(netMediaSpend).toBe(result.actualCostCents);
    });
  });
});
