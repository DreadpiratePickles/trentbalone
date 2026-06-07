/**
 * lib/generation/video-router.ts
 *
 * Submit-then-poll video generation with multi-provider fallback chain,
 * R2 provisioning check, budget enforcement, moderation filter, and
 * integration-store persistence for n8n polling.
 *
 * Key invariants:
 *  - R2 provisioning checked FIRST — bucket must exist before a billable job is submitted.
 *  - assertSpendAvailable checks budget before any provider API call.
 *  - checkModeration runs before any provider API call.
 *  - Router submits and returns immediately with status: "pending". n8n polls,
 *    downloads, uploads to R2, and writes the ledger entry.
 *  - Job stored via store.upsertIntegration with provider key "VideoJob:{jobId}".
 *  - Provider submit failure falls immediately to next in chain.
 *  - AllProvidersFailedError thrown when every provider fails.
 */

import { createHash } from "node:crypto";
import { makeId, nowIso } from "@/lib/utils";
import { getEstimatedCost } from "@/lib/generation/cost-optimizer";
import type { QualityTier } from "@/lib/generation/cost-optimizer";
import { assertSpendAvailable } from "@/lib/spend";
import { getStatus } from "@/lib/provisioning/r2-provisioner";
import type { R2ProvisionedResource } from "@/lib/provisioning/r2-provisioner";
import { R2NotProvisionedError } from "@/lib/generation/image-router";
import { checkModeration, ModerationBlockedError } from "@/lib/generation/moderation-filter";
import { store } from "@/lib/store";

// ── Provider interface ────────────────────────────────────────────────────────

export interface VideoProvider {
  readonly provider: string;
  readonly model: string;
  submit(req: VideoProviderRequest): Promise<{ providerJobId: string }>;
}

export type VideoProviderRequest = {
  prompt: string;
  durationSeconds: number;
  qualityTier: QualityTier;
};

// ── Public types ──────────────────────────────────────────────────────────────

export type VideoGenerationRequest = {
  companyId: string;
  qualityTier: QualityTier;
  prompt: string;
  durationSeconds: number;
  description: string;
};

export type VideoJobStatus = "pending" | "processing" | "completed" | "failed";

export type VideoGenerationJob = {
  jobId: string;
  companyId: string;
  providerJobId: string;
  provider: string;
  model: string;
  qualityTier: QualityTier;
  status: VideoJobStatus;
  fingerprint: string;
  estimatedCostCents: number;
  durationSeconds: number;
  prompt: string;
  description: string;
  submittedAt: string;
  /** CDN URL — null until n8n uploads to R2 on completion. */
  r2Url: string | null;
};

export type VideoRouterOptions = {
  providers?: VideoProvider[];
  /**
   * Override R2 provisioned resource lookup.
   * - `undefined`: calls getStatus(companyId)
   * - explicit value (including `null`): used directly (for testing)
   */
  r2ProvisionedResource?: R2ProvisionedResource | null;
};

// ── Error types ───────────────────────────────────────────────────────────────

export class AllProvidersFailedError extends Error {
  constructor(
    readonly qualityTier: QualityTier,
    readonly attempts: Array<{ provider: string; model: string; error: string }>
  ) {
    const summary = attempts.map(a => `${a.provider}/${a.model}: ${a.error}`).join("; ");
    super(`All video providers failed for ${qualityTier} quality. Attempts: [${summary}]`);
    this.name = "AllProvidersFailedError";
  }
}

// ── Fallback chains ───────────────────────────────────────────────────────────

type ProviderConfig = { provider: string; model: string };

const VIDEO_FALLBACK_CHAIN: Record<QualityTier, ProviderConfig[]> = {
  draft:    [
    { provider: "kling",  model: "kling-v1"      },
    { provider: "pika",   model: "pika-1.5"       },
  ],
  standard: [
    { provider: "luma",   model: "dream-machine"  },
    { provider: "kling",  model: "kling-v1"       },
  ],
  premium:  [
    { provider: "runway", model: "gen3-alpha"     },
    { provider: "luma",   model: "dream-machine"  },
  ],
};

// ── Real provider implementations ─────────────────────────────────────────────

class KlingVideoProvider implements VideoProvider {
  readonly provider = "kling";
  readonly model: string;
  constructor(model: string) { this.model = model; }

  async submit(req: VideoProviderRequest): Promise<{ providerJobId: string }> {
    const apiKey = process.env.KLING_API_KEY ?? "";
    const res = await fetch("https://api.klingai.com/v1/videos/text2video", {
      method:  "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
      body:    JSON.stringify({ model_name: this.model, prompt: req.prompt, duration: String(req.durationSeconds) }),
      signal:  AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`Kling HTTP ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as { data?: { task_id?: string } };
    const taskId = data.data?.task_id;
    if (!taskId) throw new Error("Kling: missing task_id in response");
    return { providerJobId: taskId };
  }
}

class LumaVideoProvider implements VideoProvider {
  readonly provider = "luma";
  readonly model: string;
  constructor(model: string) { this.model = model; }

  async submit(req: VideoProviderRequest): Promise<{ providerJobId: string }> {
    const apiKey = process.env.LUMAAI_API_KEY ?? "";
    const res = await fetch("https://api.lumalabs.ai/dream-machine/v1/generations", {
      method:  "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
      body:    JSON.stringify({ prompt: req.prompt }),
      signal:  AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`Luma HTTP ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as { id?: string };
    if (!data.id) throw new Error("Luma: missing id in response");
    return { providerJobId: data.id };
  }
}

class RunwayVideoProvider implements VideoProvider {
  readonly provider = "runway";
  readonly model: string;
  constructor(model: string) { this.model = model; }

  async submit(req: VideoProviderRequest): Promise<{ providerJobId: string }> {
    const apiKey = process.env.RUNWAYML_API_SECRET ?? "";
    const res = await fetch("https://api.dev.runwayml.com/v1/image_to_video", {
      method:  "POST",
      headers: {
        "Content-Type":    "application/json",
        "Authorization":   `Bearer ${apiKey}`,
        "X-Runway-Version": "2024-11-06",
      },
      body:   JSON.stringify({ model: this.model, promptText: req.prompt, duration: req.durationSeconds <= 5 ? 5 : 10 }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`Runway HTTP ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as { id?: string };
    if (!data.id) throw new Error("Runway: missing id in response");
    return { providerJobId: data.id };
  }
}

class PikaVideoProvider implements VideoProvider {
  readonly provider = "pika";
  readonly model: string;
  constructor(model: string) { this.model = model; }

  async submit(req: VideoProviderRequest): Promise<{ providerJobId: string }> {
    const apiKey = process.env.PIKA_API_KEY ?? "";
    const res = await fetch("https://api.pika.art/v1/generate", {
      method:  "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
      body:    JSON.stringify({ promptText: req.prompt, options: { frameRate: 24, duration: req.durationSeconds } }),
      signal:  AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`Pika HTTP ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as { data?: { task_id?: string } };
    const taskId = data.data?.task_id;
    if (!taskId) throw new Error("Pika: missing task_id in response");
    return { providerJobId: taskId };
  }
}

function createDefaultProviders(qualityTier: QualityTier): VideoProvider[] {
  return VIDEO_FALLBACK_CHAIN[qualityTier].map(cfg => {
    switch (cfg.provider) {
      case "kling":  return new KlingVideoProvider(cfg.model);
      case "luma":   return new LumaVideoProvider(cfg.model);
      case "runway": return new RunwayVideoProvider(cfg.model);
      case "pika":   return new PikaVideoProvider(cfg.model);
      default:       throw new Error(`Unknown video provider: ${cfg.provider}`);
    }
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function computeFingerprint(
  prompt: string,
  qualityTier: QualityTier,
  durationSeconds: number,
  model: string,
): string {
  return createHash("sha256")
    .update(JSON.stringify({ prompt, qualityTier, durationSeconds, model }))
    .digest("hex");
}

const jobProviderKey = (jobId: string) => `VideoJob:${jobId}`;

// ── submitVideoJob ────────────────────────────────────────────────────────────

export async function submitVideoJob(
  req: VideoGenerationRequest,
  options?: VideoRouterOptions
): Promise<VideoGenerationJob> {
  // 1. R2 provisioning check FIRST
  const r2Resource = "r2ProvisionedResource" in (options ?? {})
    ? options!.r2ProvisionedResource
    : await getStatus(req.companyId);

  if (!r2Resource) throw new R2NotProvisionedError(req.companyId);

  // 2. Budget check — reserves estimated spend before any provider call
  const estimatedCostCents = Math.ceil(
    getEstimatedCost("video", req.qualityTier, req.durationSeconds)
  );
  await assertSpendAvailable(req.companyId, estimatedCostCents, req.description);

  // 3. Moderation check
  const modResult = checkModeration(req.prompt, "video");
  if (modResult.verdict === "block") {
    throw new ModerationBlockedError(modResult);
  }

  // 4. Try each provider in order; fall to next on submission failure
  const providers = options?.providers ?? createDefaultProviders(req.qualityTier);
  const attempts: Array<{ provider: string; model: string; error: string }> = [];

  for (const p of providers) {
    try {
      const { providerJobId } = await p.submit({
        prompt:          req.prompt,
        durationSeconds: req.durationSeconds,
        qualityTier:     req.qualityTier,
      });

      const jobId      = makeId("vjob");
      const fingerprint = computeFingerprint(req.prompt, req.qualityTier, req.durationSeconds, p.model);

      const job: VideoGenerationJob = {
        jobId,
        companyId:          req.companyId,
        providerJobId,
        provider:           p.provider,
        model:              p.model,
        qualityTier:        req.qualityTier,
        status:             "pending",
        fingerprint,
        estimatedCostCents,
        durationSeconds:    req.durationSeconds,
        prompt:             req.prompt,
        description:        req.description,
        submittedAt:        nowIso(),
        r2Url:              null,
      };

      // 5. Persist job for n8n polling
      await store.upsertIntegration({
        companyId:     req.companyId,
        provider:      jobProviderKey(jobId),
        scopes:        [],
        status:        "connected",
        encryptedData: JSON.stringify(job),
      });

      return job;
    } catch (err) {
      if (err instanceof R2NotProvisionedError) throw err;

      attempts.push({
        provider: p.provider,
        model:    p.model,
        error:    err instanceof Error ? err.message : String(err),
      });
    }
  }

  throw new AllProvidersFailedError(req.qualityTier, attempts);
}

// ── getVideoJob ───────────────────────────────────────────────────────────────

export async function getVideoJob(
  companyId: string,
  jobId: string
): Promise<VideoGenerationJob | null> {
  const connection = await store.getIntegration(companyId, jobProviderKey(jobId));
  if (!connection?.encryptedData) return null;
  try {
    return JSON.parse(connection.encryptedData) as VideoGenerationJob;
  } catch {
    return null;
  }
}

// ── updateVideoJobStatus (for n8n polling workflow) ───────────────────────────

export async function updateVideoJobStatus(
  companyId: string,
  jobId: string,
  update: Partial<Pick<VideoGenerationJob, "status" | "r2Url">>
): Promise<VideoGenerationJob | null> {
  const existing = await getVideoJob(companyId, jobId);
  if (!existing) return null;

  const updated: VideoGenerationJob = { ...existing, ...update };
  await store.upsertIntegration({
    companyId,
    provider:      jobProviderKey(jobId),
    scopes:        [],
    status:        "connected",
    encryptedData: JSON.stringify(updated),
  });
  return updated;
}
