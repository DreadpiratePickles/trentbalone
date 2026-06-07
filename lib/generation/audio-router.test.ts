import { describe, expect, it } from "vitest";
import {
  generateAudio,
  AllProvidersFailedError,
  AudioUploadError,
  type AudioProvider,
  type AudioProviderRequest,
  type AudioProviderResponse,
  type R2StorageClient,
} from "@/lib/generation/audio-router";
import { R2NotProvisionedError } from "@/lib/generation/image-router";
import { ModerationBlockedError } from "@/lib/generation/moderation-filter";
import { SpendCapExceededError } from "@/lib/spend";
import { store } from "@/lib/store";
import type { R2ProvisionedResource } from "@/lib/provisioning/r2-provisioner";

// ---------------------------------------------------------------------------
// Fake providers and R2 clients
// ---------------------------------------------------------------------------

const FAKE_AUDIO_DATA = Buffer.from("RIFF....WAVEfmt ");

function makeProvider(
  provider: string,
  model: string,
  behavior: "succeed" | "fail" | "empty",
  audioData: Buffer = FAKE_AUDIO_DATA
): AudioProvider {
  return {
    provider,
    model,
    async generate(_req: AudioProviderRequest): Promise<AudioProviderResponse> {
      if (behavior === "fail")  throw new Error(`${provider}: simulated failure`);
      if (behavior === "empty") return { audioData: Buffer.alloc(0), format: "mp3" };
      return { audioData, format: "mp3" };
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
  bucketName: "trent-audio-co",
  publicUrl:  "https://trent-audio-co.r2.dev",
  cdnUrl:     "https://trent-audio-co.r2.dev",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeCompany(budgetCents: number, spentCents = 0) {
  const company = await store.createCompany({
    name: `AudioRouter-${Date.now()}-${Math.random()}`,
    budgetCents,
    brief: { vision: "audio router tests" },
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

const PRIMARY   = makeProvider("openai",     "tts-1",            "succeed");
const SECONDARY = makeProvider("elevenlabs", "eleven_turbo_v2",  "succeed", Buffer.from("el-audio-bytes"));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("audio-router", () => {
  // ── Happy path ─────────────────────────────────────────────────────────────

  describe("happy path", () => {
    it("generates audio and returns all required fields", async () => {
      const company = await makeCompany(10_000);

      const result = await generateAudio(
        {
          companyId: company.id,
          qualityTier: "draft",
          text: "Welcome to Trent. Your AI operating system is ready.",
          description: "welcome voiceover",
        },
        { providers: [PRIMARY], r2Client: makeR2(), r2ProvisionedResource: FAKE_R2_RESOURCE }
      );

      expect(result.r2Url).toMatch(/^https?:\/\/.+/);
      expect(result.provider).toBe("openai");
      expect(result.model).toBe("tts-1");
      expect(result.qualityTier).toBe("draft");
      expect(result.actualCostCents).toBeGreaterThan(0);
      expect(result.fingerprint).toMatch(/^[a-f0-9]{64}$/);
      expect(result.format).toMatch(/^(mp3|wav)$/);
      expect(result.durationSeconds).toBeGreaterThan(0);
    });

    it("actualCostCents is a positive integer", async () => {
      const company = await makeCompany(10_000);

      const result = await generateAudio(
        { companyId: company.id, qualityTier: "draft", text: "Short clip.", description: "integer cost" },
        { providers: [PRIMARY], r2Client: makeR2(), r2ProvisionedResource: FAKE_R2_RESOURCE }
      );

      expect(Number.isInteger(result.actualCostCents)).toBe(true);
      expect(result.actualCostCents).toBeGreaterThan(0);
    });

    it("durationSeconds is positive and scales with text length", async () => {
      const company = await makeCompany(10_000);
      const shortText = "Hi.";
      const longText  = "A".repeat(250); // ~20 seconds

      const short = await generateAudio(
        { companyId: company.id, qualityTier: "draft", text: shortText, description: "short" },
        { providers: [PRIMARY], r2Client: makeR2(), r2ProvisionedResource: FAKE_R2_RESOURCE }
      );
      const long = await generateAudio(
        { companyId: company.id, qualityTier: "draft", text: longText, description: "long" },
        { providers: [PRIMARY], r2Client: makeR2(), r2ProvisionedResource: FAKE_R2_RESOURCE }
      );

      expect(short.durationSeconds).toBeGreaterThan(0);
      expect(long.durationSeconds).toBeGreaterThan(short.durationSeconds);
    });
  });

  // ── Request passthrough ────────────────────────────────────────────────────

  describe("request passthrough", () => {
    it("passes voiceId to the provider when provided", async () => {
      const company = await makeCompany(10_000);
      const capturedRequests: AudioProviderRequest[] = [];

      const spy: AudioProvider = {
        provider: "elevenlabs", model: "eleven_turbo_v2",
        async generate(req) {
          capturedRequests.push(req);
          return { audioData: FAKE_AUDIO_DATA, format: "mp3" };
        },
      };

      await generateAudio(
        {
          companyId: company.id,
          qualityTier: "draft",
          text: "Hello.",
          voiceId: "voice_abc123",
          description: "voice id test",
        },
        { providers: [spy], r2Client: makeR2(), r2ProvisionedResource: FAKE_R2_RESOURCE }
      );

      expect(capturedRequests).toHaveLength(1);
      expect(capturedRequests[0].voiceId).toBe("voice_abc123");
    });

    it("passes speed to the provider when provided", async () => {
      const company = await makeCompany(10_000);
      const capturedRequests: AudioProviderRequest[] = [];

      const spy: AudioProvider = {
        provider: "openai", model: "tts-1",
        async generate(req) {
          capturedRequests.push(req);
          return { audioData: FAKE_AUDIO_DATA, format: "mp3" };
        },
      };

      await generateAudio(
        {
          companyId: company.id,
          qualityTier: "draft",
          text: "Speed test.",
          speed: 1.25,
          description: "speed test",
        },
        { providers: [spy], r2Client: makeR2(), r2ProvisionedResource: FAKE_R2_RESOURCE }
      );

      expect(capturedRequests[0].speed).toBe(1.25);
    });
  });

  // ── Fingerprint ────────────────────────────────────────────────────────────

  describe("fingerprint", () => {
    it("fingerprint is a 64-char SHA-256 hex string", async () => {
      const company = await makeCompany(10_000);
      const result = await generateAudio(
        { companyId: company.id, qualityTier: "draft", text: "Test.", description: "fp" },
        { providers: [PRIMARY], r2Client: makeR2(), r2ProvisionedResource: FAKE_R2_RESOURCE }
      );
      expect(result.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    });

    it("fingerprint is deterministic — same inputs produce the same fingerprint", async () => {
      const company = await makeCompany(10_000);
      const req = {
        companyId: company.id,
        qualityTier: "draft" as const,
        text: "Same voiceover script.",
        description: "determinism",
      };

      const a = await generateAudio(req, { providers: [PRIMARY], r2Client: makeR2(), r2ProvisionedResource: FAKE_R2_RESOURCE });
      const b = await generateAudio(req, { providers: [PRIMARY], r2Client: makeR2(), r2ProvisionedResource: FAKE_R2_RESOURCE });

      expect(a.fingerprint).toBe(b.fingerprint);
    });

    it("fingerprint changes when the text changes", async () => {
      const company = await makeCompany(10_000);
      const opts = { providers: [PRIMARY], r2Client: makeR2(), r2ProvisionedResource: FAKE_R2_RESOURCE };

      const a = await generateAudio({ companyId: company.id, qualityTier: "draft", text: "Script A.", description: "fp-a" }, opts);
      const b = await generateAudio({ companyId: company.id, qualityTier: "draft", text: "Script B.", description: "fp-b" }, opts);

      expect(a.fingerprint).not.toBe(b.fingerprint);
    });

    it("fingerprint is computed from inputs only — different audio bytes produce the same fingerprint", async () => {
      const company = await makeCompany(10_000);
      const req = { companyId: company.id, qualityTier: "draft" as const, text: "Same text.", description: "fp-input-only" };

      const providerA = makeProvider("openai", "tts-1", "succeed", Buffer.from("audio-bytes-version-1"));
      const providerB = makeProvider("openai", "tts-1", "succeed", Buffer.from("audio-bytes-version-2"));

      const a = await generateAudio(req, { providers: [providerA], r2Client: makeR2(), r2ProvisionedResource: FAKE_R2_RESOURCE });
      const b = await generateAudio(req, { providers: [providerB], r2Client: makeR2(), r2ProvisionedResource: FAKE_R2_RESOURCE });

      expect(a.r2Url).not.toBe(b.r2Url);
      expect(a.fingerprint).toBe(b.fingerprint);
    });
  });

  // ── Fallback chain ─────────────────────────────────────────────────────────

  describe("fallback chain", () => {
    it("falls back to the second provider when the primary fails", async () => {
      const company  = await makeCompany(10_000);
      const failing  = makeProvider("openai",     "tts-1",           "fail");
      const working  = makeProvider("elevenlabs", "eleven_turbo_v2", "succeed", Buffer.from("el-audio"));

      const result = await generateAudio(
        { companyId: company.id, qualityTier: "draft", text: "Test.", description: "fallback" },
        { providers: [failing, working], r2Client: makeR2(), r2ProvisionedResource: FAKE_R2_RESOURCE }
      );

      expect(result.provider).toBe("elevenlabs");
      expect(result.model).toBe("eleven_turbo_v2");
    });

    it("skips providers that return empty audio data", async () => {
      const company = await makeCompany(10_000);
      const empty   = makeProvider("openai",     "tts-1",           "empty");
      const working = makeProvider("elevenlabs", "eleven_turbo_v2", "succeed", Buffer.from("real-audio"));

      const result = await generateAudio(
        { companyId: company.id, qualityTier: "draft", text: "Test.", description: "empty fallback" },
        { providers: [empty, working], r2Client: makeR2(), r2ProvisionedResource: FAKE_R2_RESOURCE }
      );

      expect(result.model).toBe("eleven_turbo_v2");
    });

    it("throws AllProvidersFailedError when every provider fails", async () => {
      const company = await makeCompany(10_000);
      const fail1   = makeProvider("openai",     "tts-1",           "fail");
      const fail2   = makeProvider("elevenlabs", "eleven_turbo_v2", "fail");

      await expect(
        generateAudio(
          { companyId: company.id, qualityTier: "draft", text: "Test.", description: "all fail" },
          { providers: [fail1, fail2], r2Client: makeR2(), r2ProvisionedResource: FAKE_R2_RESOURCE }
        )
      ).rejects.toBeInstanceOf(AllProvidersFailedError);
    });

    it("AllProvidersFailedError lists every attempted provider", async () => {
      const company = await makeCompany(10_000);
      const fail1   = makeProvider("openai",     "tts-1",           "fail");
      const fail2   = makeProvider("elevenlabs", "eleven_turbo_v2", "fail");

      let caught: AllProvidersFailedError | undefined;
      try {
        await generateAudio(
          { companyId: company.id, qualityTier: "draft", text: "Test.", description: "inspect" },
          { providers: [fail1, fail2], r2Client: makeR2(), r2ProvisionedResource: FAKE_R2_RESOURCE }
        );
      } catch (err) {
        if (err instanceof AllProvidersFailedError) caught = err;
      }

      expect(caught).toBeDefined();
      expect(caught!.attempts).toHaveLength(2);
      expect(caught!.attempts.map(a => a.provider)).toEqual(["openai", "elevenlabs"]);
    });
  });

  // ── R2 integration ─────────────────────────────────────────────────────────

  describe("R2 integration", () => {
    it("throws R2NotProvisionedError before calling any generation provider", async () => {
      const company   = await makeCompany(10_000);
      const callCount = { value: 0 };

      const spy: AudioProvider = {
        provider: "openai", model: "tts-1",
        async generate(_req) {
          callCount.value++;
          return { audioData: FAKE_AUDIO_DATA, format: "mp3" };
        },
      };

      await expect(
        generateAudio(
          { companyId: company.id, qualityTier: "draft", text: "Test.", description: "no r2" },
          { providers: [spy], r2Client: makeR2(), r2ProvisionedResource: null }
        )
      ).rejects.toBeInstanceOf(R2NotProvisionedError);

      expect(callCount.value).toBe(0);
    });

    it("throws AudioUploadError when R2 upload fails after generation", async () => {
      const company = await makeCompany(10_000);

      await expect(
        generateAudio(
          { companyId: company.id, qualityTier: "draft", text: "Test.", description: "upload fail" },
          { providers: [PRIMARY], r2Client: makeR2("fail"), r2ProvisionedResource: FAKE_R2_RESOURCE }
        )
      ).rejects.toBeInstanceOf(AudioUploadError);
    });
  });

  // ── Budget enforcement ─────────────────────────────────────────────────────

  describe("budget enforcement", () => {
    it("throws SpendCapExceededError before calling any provider when budget is exhausted", async () => {
      const company   = await makeCompany(10, 10);
      const callCount = { value: 0 };

      const spy: AudioProvider = {
        provider: "openai", model: "tts-1",
        async generate(_req) {
          callCount.value++;
          return { audioData: FAKE_AUDIO_DATA, format: "mp3" };
        },
      };

      await expect(
        generateAudio(
          { companyId: company.id, qualityTier: "draft", text: "Test.", description: "blocked" },
          { providers: [spy], r2Client: makeR2(), r2ProvisionedResource: FAKE_R2_RESOURCE }
        )
      ).rejects.toBeInstanceOf(SpendCapExceededError);

      expect(callCount.value).toBe(0);
    });
  });

  // ── Moderation ────────────────────────────────────────────────────────────

  describe("moderation", () => {
    it("throws ModerationBlockedError before calling any provider for blocked text", async () => {
      const company = await makeCompany(10_000);
      const callCount = { value: 0 };

      const spy: AudioProvider = {
        provider: "openai", model: "tts-1",
        async generate(_req) {
          callCount.value++;
          return { audioData: FAKE_AUDIO_DATA, format: "mp3" };
        },
      };

      await expect(
        generateAudio(
          {
            companyId: company.id,
            qualityTier: "draft",
            text: "Narrate how to synthesize fentanyl in a home lab.",
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

      await generateAudio(
        { companyId: company.id, qualityTier: "draft", text: "Ledger test.", description: "ledger" },
        { providers: [PRIMARY], r2Client: makeR2(), r2ProvisionedResource: FAKE_R2_RESOURCE }
      );

      const usage = await store.listUsage(company.id);
      expect(usage.filter(u => u.category === "media").length).toBeGreaterThan(0);
    });

    it("net media spend matches actualCostCents", async () => {
      const company = await makeCompany(10_000);

      const result = await generateAudio(
        { companyId: company.id, qualityTier: "draft", text: "Net spend test.", description: "net spend" },
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
