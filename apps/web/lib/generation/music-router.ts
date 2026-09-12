/**
 * lib/generation/music-router.ts
 *
 * Submit-then-poll music generation with Suno/Udio fallback, R2 readiness,
 * budget enforcement, moderation, and integration-store persistence for n8n.
 */

import { createHash } from "node:crypto";
import { selectModel } from "@/lib/generation/cost-optimizer";
import type { QualityTier } from "@/lib/generation/cost-optimizer";
import { R2NotProvisionedError } from "@/lib/generation/image-router";
import { checkModeration, ModerationBlockedError } from "@/lib/generation/moderation-filter";
import { getStatus } from "@/lib/provisioning/r2-provisioner";
import type { R2ProvisionedResource } from "@/lib/provisioning/r2-provisioner";
import { store } from "@/lib/store";
import { makeId, nowIso } from "@/lib/utils";

export interface MusicProvider {
  readonly provider: string;
  readonly model: string;
  submit(req: MusicProviderRequest): Promise<{ providerJobId: string }>;
}

export type MusicProviderRequest = {
  prompt: string;
  genre?: string;
  mood?: string;
  durationSeconds: number;
  qualityTier: QualityTier;
};

export type MusicGenerationRequest = {
  companyId: string;
  qualityTier: QualityTier;
  prompt: string;
  genre?: string;
  mood?: string;
  durationSeconds: number;
  description: string;
};

export type MusicJobStatus = "pending" | "processing" | "completed" | "failed";

export type MusicGenerationJob = {
  jobId: string;
  companyId: string;
  providerJobId: string;
  provider: string;
  model: string;
  qualityTier: QualityTier;
  status: MusicJobStatus;
  fingerprint: string;
  estimatedCostCents: number;
  durationSeconds: number;
  prompt: string;
  genre?: string;
  mood?: string;
  description: string;
  submittedAt: string;
  r2Url: string | null;
};

export type MusicRouterOptions = {
  providers?: MusicProvider[];
  r2ProvisionedResource?: R2ProvisionedResource | null;
};

export class AllMusicProvidersFailedError extends Error {
  constructor(
    readonly qualityTier: QualityTier,
    readonly attempts: Array<{ provider: string; model: string; error: string }>
  ) {
    const summary = attempts.map(a => `${a.provider}/${a.model}: ${a.error}`).join("; ");
    super(`All music providers failed for ${qualityTier} quality. Attempts: [${summary}]`);
    this.name = "AllMusicProvidersFailedError";
  }
}

type ProviderConfig = { provider: "suno" | "udio"; model: string };

const MUSIC_FALLBACK_CHAIN: Record<QualityTier, ProviderConfig[]> = {
  draft: [
    { provider: "suno", model: "chirp-v3" },
    { provider: "udio", model: "udio-130" },
  ],
  standard: [
    { provider: "udio", model: "udio-130" },
    { provider: "suno", model: "chirp-v3" },
  ],
  premium: [
    { provider: "suno", model: "chirp-v4" },
    { provider: "udio", model: "udio-130" },
  ],
};

class SunoMusicProvider implements MusicProvider {
  readonly provider = "suno";
  readonly model: string;

  constructor(model: string) {
    this.model = model;
  }

  async submit(req: MusicProviderRequest): Promise<{ providerJobId: string }> {
    const res = await fetch("https://api.suno.ai/v1/generations", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.SUNO_API_KEY ?? ""}`,
      },
      body: JSON.stringify({
        model: this.model,
        prompt: req.prompt,
        tags: [req.genre, req.mood].filter(Boolean).join(", "),
        duration: req.durationSeconds,
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) throw new Error(`Suno HTTP ${res.status}`);
    const data = (await res.json()) as { id?: string; generation_id?: string };
    const id = data.id ?? data.generation_id;
    if (!id) throw new Error("Suno: missing generation id in response");
    return { providerJobId: id };
  }
}

class UdioMusicProvider implements MusicProvider {
  readonly provider = "udio";
  readonly model: string;

  constructor(model: string) {
    this.model = model;
  }

  async submit(req: MusicProviderRequest): Promise<{ providerJobId: string }> {
    const res = await fetch("https://api.udio.com/v1/generations", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.UDIO_API_KEY ?? ""}`,
      },
      body: JSON.stringify({
        model: this.model,
        prompt: req.prompt,
        genre: req.genre,
        mood: req.mood,
        duration_seconds: req.durationSeconds,
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) throw new Error(`Udio HTTP ${res.status}`);
    const data = (await res.json()) as { id?: string; job_id?: string };
    const id = data.id ?? data.job_id;
    if (!id) throw new Error("Udio: missing job id in response");
    return { providerJobId: id };
  }
}

function createDefaultProviders(qualityTier: QualityTier): MusicProvider[] {
  return MUSIC_FALLBACK_CHAIN[qualityTier].map(cfg =>
    cfg.provider === "suno"
      ? new SunoMusicProvider(cfg.model)
      : new UdioMusicProvider(cfg.model)
  );
}

function computeFingerprint(req: MusicGenerationRequest, model: string): string {
  return createHash("sha256")
    .update(JSON.stringify({
      prompt: req.prompt,
      genre: req.genre ?? null,
      mood: req.mood ?? null,
      durationSeconds: req.durationSeconds,
      qualityTier: req.qualityTier,
      model,
    }))
    .digest("hex");
}

const jobProviderKey = (jobId: string) => `MusicJob:${jobId}`;

export async function submitMusicJob(
  req: MusicGenerationRequest,
  options?: MusicRouterOptions
): Promise<MusicGenerationJob> {
  const r2Resource = "r2ProvisionedResource" in (options ?? {})
    ? options!.r2ProvisionedResource
    : await getStatus(req.companyId);

  if (!r2Resource) throw new R2NotProvisionedError(req.companyId);

  const selection = await selectModel({
    companyId: req.companyId,
    taskType: "music",
    qualityTier: req.qualityTier,
    estimatedUnits: req.durationSeconds,
    description: req.description,
  });

  const moderationInput = [req.prompt, req.genre, req.mood].filter(Boolean).join("\n");
  const modResult = checkModeration(moderationInput, "music");
  if (modResult.verdict === "block") {
    throw new ModerationBlockedError(modResult);
  }

  const providers = options?.providers ?? createDefaultProviders(req.qualityTier);
  const attempts: Array<{ provider: string; model: string; error: string }> = [];

  for (const p of providers) {
    try {
      const { providerJobId } = await p.submit({
        prompt: req.prompt,
        genre: req.genre,
        mood: req.mood,
        durationSeconds: req.durationSeconds,
        qualityTier: req.qualityTier,
      });

      const jobId = makeId("mjob");
      const fingerprint = computeFingerprint(req, p.model);
      const job: MusicGenerationJob = {
        jobId,
        companyId: req.companyId,
        providerJobId,
        provider: p.provider,
        model: p.model,
        qualityTier: req.qualityTier,
        status: "pending",
        fingerprint,
        estimatedCostCents: Math.ceil(selection.estimatedCostCents),
        durationSeconds: req.durationSeconds,
        prompt: req.prompt,
        genre: req.genre,
        mood: req.mood,
        description: req.description,
        submittedAt: nowIso(),
        r2Url: null,
      };

      await store.upsertIntegration({
        companyId: req.companyId,
        provider: jobProviderKey(jobId),
        scopes: [],
        status: "connected",
        encryptedData: JSON.stringify(job),
      });

      return job;
    } catch (err) {
      attempts.push({
        provider: p.provider,
        model: p.model,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  throw new AllMusicProvidersFailedError(req.qualityTier, attempts);
}

export async function getMusicJob(
  companyId: string,
  jobId: string
): Promise<MusicGenerationJob | null> {
  const connection = await store.getIntegration(companyId, jobProviderKey(jobId));
  if (!connection?.encryptedData) return null;
  try {
    return JSON.parse(connection.encryptedData) as MusicGenerationJob;
  } catch {
    return null;
  }
}

export async function updateMusicJobStatus(
  companyId: string,
  jobId: string,
  update: Partial<Pick<MusicGenerationJob, "status" | "r2Url">>
): Promise<MusicGenerationJob | null> {
  const existing = await getMusicJob(companyId, jobId);
  if (!existing) return null;

  const updated: MusicGenerationJob = { ...existing, ...update };
  await store.upsertIntegration({
    companyId,
    provider: jobProviderKey(jobId),
    scopes: [],
    status: "connected",
    encryptedData: JSON.stringify(updated),
  });
  return updated;
}
