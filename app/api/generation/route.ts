import { NextResponse } from "next/server";
import { store } from "@/lib/store";
import { getAuthUser, unauthorized, forbidden, requireRoleForRequest } from "@/lib/session";
import { checkRateLimit, rateLimitExceeded } from "@/lib/rate-limit";
import { withRlsContext } from "@/lib/with-rls";
import { generateText } from "@/lib/generation/text-router";
import { generateImage } from "@/lib/generation/image-router";
import { generateAudio } from "@/lib/generation/audio-router";
import { submitVideoJob } from "@/lib/generation/video-router";
import { submitMusicJob } from "@/lib/generation/music-router";
import type { QualityTier } from "@/lib/generation/cost-optimizer";

type GenerationType = "text" | "image" | "audio" | "video" | "music";
type GenerationBody = Record<string, unknown> & {
  companyId?: string;
  type?: GenerationType;
  qualityTier?: QualityTier;
};

const VALID_TYPES = new Set<GenerationType>(["text", "image", "audio", "video", "music"]);
const VALID_TIERS = new Set<QualityTier>(["draft", "standard", "premium"]);

export async function POST(request: Request) {
  const user = await getAuthUser();
  if (!user) return unauthorized();

  const body = await request.json().catch(() => ({})) as GenerationBody;
  if (!body.companyId || !body.type || !VALID_TYPES.has(body.type)) {
    return NextResponse.json(
      { error: "companyId and valid type are required" },
      { status: 400 }
    );
  }

  const company = await store.getCompany(body.companyId);
  if (!company) return NextResponse.json({ error: "Company not found" }, { status: 404 });

  const check = await requireRoleForRequest(user.id, "member", { companyId: company.id });
  if (!check.ok) return forbidden();

  const rateLimit = await checkRateLimit(user.id, company.id);
  if (!rateLimit.ok) return rateLimitExceeded(rateLimit.retryAfterSeconds);

  return withRlsContext(company.id, async () => {
    try {
      const result = await dispatchGeneration(company.id, body);
      return NextResponse.json({ result });
    } catch (err) {
      if (err instanceof InvalidGenerationRequestError) {
        return NextResponse.json({ error: err.message }, { status: 400 });
      }
      throw err;
    }
  });
}

async function dispatchGeneration(companyId: string, body: GenerationBody) {
  const qualityTier = VALID_TIERS.has(body.qualityTier as QualityTier)
    ? body.qualityTier as QualityTier
    : "draft";
  const description = optionalString(body.description) ?? `Generate ${body.type}`;

  switch (body.type) {
    case "text":
      return generateText({
        companyId,
        qualityTier,
        prompt: requiredString(body.prompt, "prompt"),
        systemPrompt: optionalString(body.systemPrompt),
        brandVoiceContext: optionalString(body.brandVoiceContext),
        maxTokens: optionalNumber(body.maxTokens),
        description,
      });
    case "image":
      return generateImage({
        companyId,
        qualityTier,
        prompt: requiredString(body.prompt, "prompt"),
        negativePrompt: optionalString(body.negativePrompt),
        visualContext: optionalVisualContext(body.visualContext),
        width: optionalNumber(body.width),
        height: optionalNumber(body.height),
        description,
      });
    case "audio":
      return generateAudio({
        companyId,
        qualityTier,
        text: requiredString(body.text ?? body.prompt, "text"),
        voiceId: optionalString(body.voiceId),
        speed: optionalNumber(body.speed),
        format: body.format === "wav" ? "wav" : "mp3",
        description,
      });
    case "video":
      return submitVideoJob({
        companyId,
        qualityTier,
        prompt: requiredString(body.prompt, "prompt"),
        durationSeconds: optionalNumber(body.durationSeconds) ?? 8,
        description,
      });
    case "music":
      return submitMusicJob({
        companyId,
        qualityTier,
        prompt: requiredString(body.prompt, "prompt"),
        genre: optionalString(body.genre),
        mood: optionalString(body.mood),
        durationSeconds: optionalNumber(body.durationSeconds) ?? 30,
        description,
      });
    default:
      throw new Error(`Unhandled generation type: ${String(body.type)}`);
  }
}

function requiredString(value: unknown, field: string) {
  if (typeof value !== "string" || !value.trim()) {
    throw new InvalidGenerationRequestError(`${field} is required`);
  }
  return value.trim();
}

function optionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function optionalVisualContext(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  return {
    positivePrompt: optionalString(record.positivePrompt),
    negativePrompt: optionalString(record.negativePrompt),
  };
}

class InvalidGenerationRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidGenerationRequestError";
  }
}
