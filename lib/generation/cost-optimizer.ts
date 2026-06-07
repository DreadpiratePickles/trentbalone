/**
 * lib/generation/cost-optimizer.ts
 *
 * Model selection by quality tier and per-company budget cap.
 *
 * Design invariants:
 *  - Task type validation fires before any I/O (UnknownTaskTypeError is sync).
 *  - selectModel() only checks budget — it does NOT reserve spend.
 *    Reservation is the caller's responsibility via assertToolSpendAllowed().
 *  - No silent quality downgrade. BudgetQualityConflictError signals that a
 *    lower tier would fit — the API surface decides what to do next.
 *  - Provider cost data is static. Prices are updated via code, not runtime
 *    fetches, keeping this module pure and deterministic.
 *
 * Unit conventions:
 *   text  — 1 unit = 1,000 tokens
 *   image — 1 unit = 1 image
 *   audio — 1 unit = 1 second of audio
 *   video — 1 unit = 1 second of video
 *   music — 1 unit = 1 second of music
 */

import { getSpendSummary, SpendCapExceededError } from "@/lib/spend";

// ── Public types ──────────────────────────────────────────────────────────────

export type QualityTier = "draft" | "standard" | "premium";
export type GenerationTaskType = "text" | "image" | "audio" | "video" | "music";

export type ModelSelectionRequest = {
  companyId: string;
  taskType: GenerationTaskType;
  qualityTier: QualityTier;
  /** Number of units to generate (see file header for unit convention per task type). */
  estimatedUnits: number;
  description: string;
};

export type ModelSelection = {
  provider: string;
  model: string;
  estimatedCostCents: number;
  qualityTier: QualityTier;
};

// ── Error types ───────────────────────────────────────────────────────────────

export class UnknownTaskTypeError extends Error {
  constructor(readonly taskType: string) {
    super(
      `Unknown generation task type: "${taskType}". ` +
      `Valid types: text, image, audio, video, music.`
    );
    this.name = "UnknownTaskTypeError";
  }
}

export class BudgetQualityConflictError extends Error {
  constructor(
    readonly taskType: GenerationTaskType,
    readonly requestedTier: QualityTier,
    /** Cost in cents of the cheapest model that meets the requested tier. */
    readonly cheapestMatchingCents: number,
    readonly remainingBudgetCents: number,
  ) {
    super(
      `${taskType}/${requestedTier} requires ${cheapestMatchingCents}¢ ` +
      `but only ${remainingBudgetCents}¢ remains. ` +
      `Draft tier would fit — downgrade to proceed.`
    );
    this.name = "BudgetQualityConflictError";
  }
}

// ── Provider roster ───────────────────────────────────────────────────────────

type ProviderSpec = {
  provider: string;
  model: string;
  /** Cost in cents per unit (see unit conventions in file header). */
  costPerUnit: number;
};

const PROVIDER_ROSTER: Record<GenerationTaskType, Record<QualityTier, ProviderSpec>> = {
  text: {
    draft:    { provider: "anthropic",  model: "claude-haiku-4-5-20251001",       costPerUnit: 0.01 },
    standard: { provider: "anthropic",  model: "claude-sonnet-4-6",               costPerUnit: 0.30 },
    premium:  { provider: "anthropic",  model: "claude-opus-4-8",                 costPerUnit: 1.50 },
  },
  image: {
    draft:    { provider: "openrouter", model: "black-forest-labs/FLUX.1-schnell", costPerUnit: 2 },
    standard: { provider: "openai",     model: "dall-e-3",                         costPerUnit: 4 },
    premium:  { provider: "openai",     model: "dall-e-3-hd",                      costPerUnit: 8 },
  },
  audio: {
    draft:    { provider: "openai",      model: "tts-1",           costPerUnit: 1 },
    standard: { provider: "elevenlabs",  model: "eleven_turbo_v2", costPerUnit: 3 },
    premium:  { provider: "elevenlabs",  model: "eleven_v2_flash", costPerUnit: 6 },
  },
  video: {
    draft:    { provider: "kling",    model: "kling-v1",      costPerUnit: 10 },
    standard: { provider: "luma",     model: "dream-machine", costPerUnit: 20 },
    premium:  { provider: "runway",   model: "gen3-alpha",    costPerUnit: 40 },
  },
  music: {
    draft:    { provider: "suno", model: "chirp-v3",  costPerUnit: 2 },
    standard: { provider: "udio", model: "udio-130",  costPerUnit: 4 },
    premium:  { provider: "suno", model: "chirp-v4",  costPerUnit: 8 },
  },
};

const VALID_TASK_TYPES = new Set<string>(["text", "image", "audio", "video", "music"]);

// ── getEstimatedCost ──────────────────────────────────────────────────────────

/**
 * Pure cost estimate — no I/O, no side effects.
 * Throws UnknownTaskTypeError synchronously for unrecognized task types.
 */
export function getEstimatedCost(
  taskType: GenerationTaskType,
  qualityTier: QualityTier,
  estimatedUnits: number,
): number {
  if (!VALID_TASK_TYPES.has(taskType as string)) {
    throw new UnknownTaskTypeError(taskType as string);
  }
  return PROVIDER_ROSTER[taskType][qualityTier].costPerUnit * estimatedUnits;
}

// ── selectModel ───────────────────────────────────────────────────────────────

/**
 * Select the optimal model for a generation task.
 *
 * Throws:
 *  - UnknownTaskTypeError      — invalid taskType (sync, before any I/O)
 *  - SpendCapExceededError     — budget exhausted or too small for any model
 *  - BudgetQualityConflictError — budget can afford draft but not the requested tier
 *
 * Does NOT reserve spend — caller must call assertToolSpendAllowed() with
 * the returned estimatedCostCents before firing any generation API.
 */
export async function selectModel(req: ModelSelectionRequest): Promise<ModelSelection> {
  // 1. Validate task type synchronously — before any I/O
  if (!VALID_TASK_TYPES.has(req.taskType as string)) {
    throw new UnknownTaskTypeError(req.taskType as string);
  }

  // 2. Compute costs for requested tier and draft tier
  const spec             = PROVIDER_ROSTER[req.taskType][req.qualityTier];
  const estimatedCostCents = spec.costPerUnit * req.estimatedUnits;
  const draftCostCents     = PROVIDER_ROSTER[req.taskType]["draft"].costPerUnit * req.estimatedUnits;

  // 3. Check company budget
  const summary = await getSpendSummary(req.companyId);

  if (summary.hardStop || summary.remainingCents < estimatedCostCents) {
    const canAffordDraft = (
      !summary.hardStop &&
      req.qualityTier !== "draft" &&
      summary.remainingCents >= draftCostCents
    );

    if (canAffordDraft) {
      throw new BudgetQualityConflictError(
        req.taskType,
        req.qualityTier,
        estimatedCostCents,
        summary.remainingCents,
      );
    }

    throw new SpendCapExceededError(
      `${req.description}: ${req.taskType}/${req.qualityTier} requires ` +
      `${estimatedCostCents}¢ but only ${summary.remainingCents}¢ remains.`,
      summary.budgetCents,
      summary.spentCents,
      estimatedCostCents,
    );
  }

  return {
    provider: spec.provider,
    model: spec.model,
    estimatedCostCents,
    qualityTier: req.qualityTier,
  };
}
