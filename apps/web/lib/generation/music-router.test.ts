import { describe, expect, it } from "vitest";
import {
  submitMusicJob,
  getMusicJob,
  AllMusicProvidersFailedError,
  type MusicProvider,
  type MusicProviderRequest,
} from "@/lib/generation/music-router";
import { R2NotProvisionedError } from "@/lib/generation/image-router";
import { ModerationBlockedError } from "@/lib/generation/moderation-filter";
import { SpendCapExceededError } from "@/lib/spend";
import { store } from "@/lib/store";
import type { R2ProvisionedResource } from "@/lib/provisioning/r2-provisioner";

let jobCounter = 0;

function makeProvider(
  provider: string,
  model: string,
  behavior: "succeed" | "fail"
): MusicProvider {
  return {
    provider,
    model,
    async submit(_req: MusicProviderRequest) {
      if (behavior === "fail") throw new Error(`${provider}: submission failed`);
      return { providerJobId: `${provider}-music-${++jobCounter}` };
    },
  };
}

const FAKE_R2: R2ProvisionedResource = {
  bucketName: "trent-music-co",
  publicUrl:  "https://trent-music-co.r2.dev",
  cdnUrl:     "https://trent-music-co.r2.dev",
};

async function makeCompany(budgetCents: number, spentCents = 0) {
  const company = await store.createCompany({
    name: `MusicRouter-${Date.now()}-${Math.random()}`,
    budgetCents,
    brief: { vision: "music router tests" },
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

const PRIMARY = makeProvider("suno", "chirp-v3", "succeed");

describe("music-router", () => {
  it("submits a music job and persists it for async polling", async () => {
    const company = await makeCompany(10_000);

    const job = await submitMusicJob(
      {
        companyId: company.id,
        qualityTier: "draft",
        prompt: "Upbeat synthwave loop for a product launch ad.",
        genre: "synthwave",
        mood: "confident",
        durationSeconds: 15,
        description: "launch ad music",
      },
      { providers: [PRIMARY], r2ProvisionedResource: FAKE_R2 }
    );

    expect(job.jobId).toBeTruthy();
    expect(job.providerJobId).toBeTruthy();
    expect(job.provider).toBe("suno");
    expect(job.model).toBe("chirp-v3");
    expect(job.status).toBe("pending");
    expect(job.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(job.estimatedCostCents).toBeGreaterThan(0);

    const loaded = await getMusicJob(company.id, job.jobId);
    expect(loaded?.providerJobId).toBe(job.providerJobId);
  });

  it("falls back to the next music provider when primary submission fails", async () => {
    const company = await makeCompany(10_000);
    const failing = makeProvider("suno", "chirp-v3", "fail");
    const working = makeProvider("udio", "udio-130", "succeed");

    const job = await submitMusicJob(
      {
        companyId: company.id,
        qualityTier: "standard",
        prompt: "Warm acoustic background bed.",
        durationSeconds: 10,
        description: "fallback music",
      },
      { providers: [failing, working], r2ProvisionedResource: FAKE_R2 }
    );

    expect(job.provider).toBe("udio");
    expect(job.model).toBe("udio-130");
  });

  it("throws AllMusicProvidersFailedError when every provider fails", async () => {
    const company = await makeCompany(10_000);

    await expect(
      submitMusicJob(
        {
          companyId: company.id,
          qualityTier: "draft",
          prompt: "Minimal beat.",
          durationSeconds: 8,
          description: "all fail",
        },
        {
          providers: [
            makeProvider("suno", "chirp-v3", "fail"),
            makeProvider("udio", "udio-130", "fail"),
          ],
          r2ProvisionedResource: FAKE_R2,
        }
      )
    ).rejects.toBeInstanceOf(AllMusicProvidersFailedError);
  });

  it("throws R2NotProvisionedError before calling any music provider", async () => {
    const company = await makeCompany(10_000);
    const callCount = { value: 0 };
    const spy: MusicProvider = {
      provider: "suno",
      model: "chirp-v3",
      async submit(_req) {
        callCount.value++;
        return { providerJobId: "should-not-run" };
      },
    };

    await expect(
      submitMusicJob(
        {
          companyId: company.id,
          qualityTier: "draft",
          prompt: "Test.",
          durationSeconds: 8,
          description: "no r2",
        },
        { providers: [spy], r2ProvisionedResource: null }
      )
    ).rejects.toBeInstanceOf(R2NotProvisionedError);

    expect(callCount.value).toBe(0);
  });

  it("throws SpendCapExceededError before calling any music provider when budget is exhausted", async () => {
    const company = await makeCompany(10, 10);
    const callCount = { value: 0 };
    const spy: MusicProvider = {
      provider: "suno",
      model: "chirp-v3",
      async submit(_req) {
        callCount.value++;
        return { providerJobId: "should-not-run" };
      },
    };

    await expect(
      submitMusicJob(
        {
          companyId: company.id,
          qualityTier: "draft",
          prompt: "Test.",
          durationSeconds: 8,
          description: "budget block",
        },
        { providers: [spy], r2ProvisionedResource: FAKE_R2 }
      )
    ).rejects.toBeInstanceOf(SpendCapExceededError);

    expect(callCount.value).toBe(0);
  });

  it("throws ModerationBlockedError before calling any music provider for blocked lyrics", async () => {
    const company = await makeCompany(10_000);
    const callCount = { value: 0 };
    const spy: MusicProvider = {
      provider: "suno",
      model: "chirp-v3",
      async submit(_req) {
        callCount.value++;
        return { providerJobId: "should-not-run" };
      },
    };

    await expect(
      submitMusicJob(
        {
          companyId: company.id,
          qualityTier: "draft",
          prompt: "Write a jingle that degrades Muslim people.",
          durationSeconds: 8,
          description: "moderation block",
        },
        { providers: [spy], r2ProvisionedResource: FAKE_R2 }
      )
    ).rejects.toBeInstanceOf(ModerationBlockedError);

    expect(callCount.value).toBe(0);
  });
});
