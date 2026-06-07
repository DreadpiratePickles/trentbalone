import { describe, expect, it } from "vitest";
import {
  submitVideoJob,
  getVideoJob,
  AllProvidersFailedError,
  type VideoProvider,
  type VideoProviderRequest,
} from "@/lib/generation/video-router";
import { R2NotProvisionedError } from "@/lib/generation/image-router";
import { ModerationBlockedError } from "@/lib/generation/moderation-filter";
import { SpendCapExceededError } from "@/lib/spend";
import { store } from "@/lib/store";
import type { R2ProvisionedResource } from "@/lib/provisioning/r2-provisioner";

// ---------------------------------------------------------------------------
// Fake providers
// ---------------------------------------------------------------------------

let _jobCounter = 0;

function makeProvider(
  provider: string,
  model: string,
  behavior: "succeed" | "fail"
): VideoProvider {
  return {
    provider,
    model,
    async submit(_req: VideoProviderRequest) {
      if (behavior === "fail") throw new Error(`${provider}: submission failed`);
      return { providerJobId: `${provider}-job-${++_jobCounter}` };
    },
  };
}

const FAKE_R2: R2ProvisionedResource = {
  bucketName: "trent-video-co",
  publicUrl:  "https://trent-video-co.r2.dev",
  cdnUrl:     "https://trent-video-co.r2.dev",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeCompany(budgetCents: number, spentCents = 0) {
  const company = await store.createCompany({
    name: `VideoRouter-${Date.now()}-${Math.random()}`,
    budgetCents,
    brief: { vision: "video router tests" },
  });
  if (spentCents > 0) {
    await store.addUsage({
      companyId: company.id,
      category:  "media",
      description: "pre-existing spend",
      amountCents: spentCents,
      metadata: {},
    });
  }
  return company;
}

const PRIMARY   = makeProvider("kling",   "kling-v1",       "succeed");
const SECONDARY = makeProvider("pika",    "pika-1.5",       "succeed");

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("video-router", () => {
  // ── Submission ─────────────────────────────────────────────────────────────

  describe("submitVideoJob", () => {
    it("returns a VideoGenerationJob with all required fields", async () => {
      const company = await makeCompany(10_000);

      const job = await submitVideoJob(
        {
          companyId:       company.id,
          qualityTier:     "draft",
          prompt:          "A product demo showing a SaaS dashboard being used.",
          durationSeconds: 5,
          description:     "product demo clip",
        },
        { providers: [PRIMARY], r2ProvisionedResource: FAKE_R2 }
      );

      expect(job.jobId).toBeTruthy();
      expect(job.providerJobId).toBeTruthy();
      expect(job.provider).toBe("kling");
      expect(job.model).toBe("kling-v1");
      expect(job.qualityTier).toBe("draft");
      expect(job.status).toBe("pending");
      expect(job.fingerprint).toMatch(/^[a-f0-9]{64}$/);
      expect(job.estimatedCostCents).toBeGreaterThan(0);
      expect(job.durationSeconds).toBe(5);
      expect(job.submittedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it("status is 'pending' immediately after submission", async () => {
      const company = await makeCompany(10_000);

      const job = await submitVideoJob(
        { companyId: company.id, qualityTier: "draft", prompt: "Test.", durationSeconds: 3, description: "status check" },
        { providers: [PRIMARY], r2ProvisionedResource: FAKE_R2 }
      );

      expect(job.status).toBe("pending");
    });

    it("estimatedCostCents is a positive integer and scales with durationSeconds", async () => {
      const company = await makeCompany(10_000);

      const short = await submitVideoJob(
        { companyId: company.id, qualityTier: "draft", prompt: "Test.", durationSeconds: 3,  description: "short" },
        { providers: [PRIMARY], r2ProvisionedResource: FAKE_R2 }
      );
      const long = await submitVideoJob(
        { companyId: company.id, qualityTier: "draft", prompt: "Test.", durationSeconds: 10, description: "long" },
        { providers: [PRIMARY], r2ProvisionedResource: FAKE_R2 }
      );

      expect(Number.isInteger(short.estimatedCostCents)).toBe(true);
      expect(long.estimatedCostCents).toBeGreaterThan(short.estimatedCostCents);
    });

    it("job is persisted — getVideoJob returns it", async () => {
      const company = await makeCompany(10_000);

      const submitted = await submitVideoJob(
        { companyId: company.id, qualityTier: "draft", prompt: "Test.", durationSeconds: 5, description: "persistence" },
        { providers: [PRIMARY], r2ProvisionedResource: FAKE_R2 }
      );

      const loaded = await getVideoJob(company.id, submitted.jobId);
      expect(loaded).not.toBeNull();
      expect(loaded!.jobId).toBe(submitted.jobId);
      expect(loaded!.providerJobId).toBe(submitted.providerJobId);
      expect(loaded!.status).toBe("pending");
    });
  });

  // ── Fingerprint ────────────────────────────────────────────────────────────

  describe("fingerprint", () => {
    it("fingerprint is a 64-char SHA-256 hex string", async () => {
      const company = await makeCompany(10_000);
      const job = await submitVideoJob(
        { companyId: company.id, qualityTier: "draft", prompt: "Test.", durationSeconds: 5, description: "fp" },
        { providers: [PRIMARY], r2ProvisionedResource: FAKE_R2 }
      );
      expect(job.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    });

    it("fingerprint changes when the prompt changes", async () => {
      const company = await makeCompany(10_000);
      const opts = { providers: [PRIMARY], r2ProvisionedResource: FAKE_R2 };

      const a = await submitVideoJob({ companyId: company.id, qualityTier: "draft", prompt: "Scene A.", durationSeconds: 5, description: "fp-a" }, opts);
      const b = await submitVideoJob({ companyId: company.id, qualityTier: "draft", prompt: "Scene B.", durationSeconds: 5, description: "fp-b" }, opts);

      expect(a.fingerprint).not.toBe(b.fingerprint);
    });
  });

  // ── Fallback chain ─────────────────────────────────────────────────────────

  describe("fallback chain", () => {
    it("falls back to the second provider when the primary submit fails", async () => {
      const company  = await makeCompany(10_000);
      const failing  = makeProvider("kling", "kling-v1", "fail");
      const working  = makeProvider("pika",  "pika-1.5", "succeed");

      const job = await submitVideoJob(
        { companyId: company.id, qualityTier: "draft", prompt: "Test.", durationSeconds: 5, description: "fallback" },
        { providers: [failing, working], r2ProvisionedResource: FAKE_R2 }
      );

      expect(job.provider).toBe("pika");
      expect(job.model).toBe("pika-1.5");
    });

    it("throws AllProvidersFailedError when every provider fails to submit", async () => {
      const company = await makeCompany(10_000);
      const fail1   = makeProvider("kling", "kling-v1", "fail");
      const fail2   = makeProvider("pika",  "pika-1.5", "fail");

      await expect(
        submitVideoJob(
          { companyId: company.id, qualityTier: "draft", prompt: "Test.", durationSeconds: 5, description: "all fail" },
          { providers: [fail1, fail2], r2ProvisionedResource: FAKE_R2 }
        )
      ).rejects.toBeInstanceOf(AllProvidersFailedError);
    });

    it("AllProvidersFailedError lists every attempted provider", async () => {
      const company = await makeCompany(10_000);
      const fail1   = makeProvider("kling",  "kling-v1", "fail");
      const fail2   = makeProvider("runway", "gen3",     "fail");

      let caught: AllProvidersFailedError | undefined;
      try {
        await submitVideoJob(
          { companyId: company.id, qualityTier: "draft", prompt: "Test.", durationSeconds: 5, description: "inspect" },
          { providers: [fail1, fail2], r2ProvisionedResource: FAKE_R2 }
        );
      } catch (err) {
        if (err instanceof AllProvidersFailedError) caught = err;
      }

      expect(caught).toBeDefined();
      expect(caught!.attempts).toHaveLength(2);
      expect(caught!.attempts.map(a => a.provider)).toEqual(["kling", "runway"]);
    });
  });

  // ── Pre-submission gates ───────────────────────────────────────────────────

  describe("pre-submission gates (R2, budget, moderation)", () => {
    it("throws R2NotProvisionedError before calling any provider", async () => {
      const company   = await makeCompany(10_000);
      const callCount = { value: 0 };
      const spy: VideoProvider = {
        provider: "kling", model: "kling-v1",
        async submit(_req) { callCount.value++; return { providerJobId: "job-1" }; },
      };

      await expect(
        submitVideoJob(
          { companyId: company.id, qualityTier: "draft", prompt: "Test.", durationSeconds: 5, description: "no r2" },
          { providers: [spy], r2ProvisionedResource: null }
        )
      ).rejects.toBeInstanceOf(R2NotProvisionedError);

      expect(callCount.value).toBe(0);
    });

    it("throws SpendCapExceededError before calling any provider when budget exhausted", async () => {
      const company   = await makeCompany(10, 10);
      const callCount = { value: 0 };
      const spy: VideoProvider = {
        provider: "kling", model: "kling-v1",
        async submit(_req) { callCount.value++; return { providerJobId: "job-2" }; },
      };

      await expect(
        submitVideoJob(
          { companyId: company.id, qualityTier: "draft", prompt: "Test.", durationSeconds: 5, description: "blocked" },
          { providers: [spy], r2ProvisionedResource: FAKE_R2 }
        )
      ).rejects.toBeInstanceOf(SpendCapExceededError);

      expect(callCount.value).toBe(0);
    });

    it("throws ModerationBlockedError before calling any provider for a blocked prompt", async () => {
      const company   = await makeCompany(10_000);
      const callCount = { value: 0 };
      const spy: VideoProvider = {
        provider: "kling", model: "kling-v1",
        async submit(_req) { callCount.value++; return { providerJobId: "job-3" }; },
      };

      await expect(
        submitVideoJob(
          {
            companyId: company.id,
            qualityTier: "draft",
            prompt: "Create a video showing how to brutally murder someone.",
            durationSeconds: 5,
            description: "moderation block",
          },
          { providers: [spy], r2ProvisionedResource: FAKE_R2 }
        )
      ).rejects.toBeInstanceOf(ModerationBlockedError);

      expect(callCount.value).toBe(0);
    });
  });
});
