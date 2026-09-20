/**
 * Image generation for `media_image` (design B2, gate G5): one prompt in, one image out, priced
 * in integer cents BEFORE anything is sent, so the approval can name the price and the ledger
 * can carry it.
 *
 * Providers:
 *   gemini         `POST {GEMINI_BASE_URL}/models/{model}:generateContent`, the key in the
 *                  `x-goog-api-key` header, `generationConfig.responseModalities: ["IMAGE"]` and
 *                  `imageConfig.aspectRatio`; the image comes back as
 *                  `candidates[0].content.parts[].inlineData` (`mimeType`, base64 `data`).
 *                  Confirmed 2026-09-20 against the generateContent reference
 *                  (https://ai.google.dev/api/generate-content: `responseModalities` TEXT|IMAGE,
 *                  `imageConfig` aspectRatio and imageSize, `inlineData` mimeType and data) and
 *                  priced from https://ai.google.dev/gemini-api/docs/pricing (the table below).
 *   openai-images  `POST {base}/images/generations` with a bearer, the image as `data[0].b64_json`:
 *                  OpenAI on `OPENAI_BASE_URL`, or any alias of `model-gateway/providers.ts` on its
 *                  own base URL and key. The model and the price come from the profile, because
 *                  those catalogues change faster than a shipped table would stay true.
 *
 * The app's own router (`apps/web/lib/generation/image-router.ts`) is not wrapped: it refuses to
 * generate without a provisioned R2 bucket and a company row, neither of which a standalone
 * profile has, and its price table is the app's roster, not the provider's list price.
 *
 * Nothing here logs a key. A route carries the NAME of the variable the key is read from; the
 * key is read at send time and travels in a header, never in a URL or an error.
 */
import crypto from "node:crypto";
import { EXIT, TrentError } from "../../errors/TrentError.js";
import { LOCAL_PLACEHOLDER_KEY, PROVIDER_ALIAS_ROUTES, aliasBaseUrl, resolveProviderAlias } from "../../model-gateway/providers.js";
import { sniffImage, type ImageMime } from "../vision/image-source.js";
import type { FetchLike } from "../web/proxied-fetch.js";

export const GEMINI_IMAGE_PRICING_SOURCE = "https://ai.google.dev/gemini-api/docs/pricing";
export const GEMINI_IMAGE_PRICING_DATE = "2026-09-20";
export const DEFAULT_GEMINI_IMAGE_MODEL = "gemini-3.1-flash-image";
/**
 * Cents per 1K image, rounded UP from the list price on the date above: money is integer cents,
 * and the daily cap must see at least what is billed. Output image tokens are billed at the
 * model's image rate; a 1K image is 1120 tokens on the 3.x models and 1290 on 2.5.
 */
export const GEMINI_IMAGE_PRICE_CENTS: Readonly<Record<string, number>> = {
  "gemini-3.1-flash-image": 7, // 1120 tokens at $60 per million = $0.067
  "gemini-3.1-flash-lite-image": 4, // 1120 tokens at $30 per million = $0.0336
  "gemini-3-pro-image": 14, // 1120 tokens at $120 per million = $0.134 (1K or 2K; 4K is 2000 tokens)
  "gemini-2.5-flash-image": 4, // 1290 tokens at $30 per million = $0.039
};
/** Env vars a Gemini key is read from, in order; the doctor's credentials check accepts the same three. */
export const GEMINI_KEY_ENVS = ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"] as const;
export const GEMINI_BASE_URL_ENV = "GEMINI_BASE_URL";
export const DEFAULT_GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
export const OPENAI_BASE_URL_ENV = "OPENAI_BASE_URL";
export const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
/** The framings a thumbnail or a post needs; Gemini takes the ratio as written, the OpenAI shape maps to its three sizes. */
export const IMAGE_ASPECTS = ["1:1", "16:9", "9:16", "4:3", "3:4", "4:5"] as const;
export type ImageAspect = (typeof IMAGE_ASPECTS)[number];
/** Gemini renders at 1K unless asked otherwise; the price table is the 1K price. */
const GEMINI_IMAGE_SIZE = "1K";
const IMAGE_TIMEOUT_MS = 120_000;
const ERROR_TEXT_LIMIT = 200;

/** The `media.image_*` keys, as the adapter hands them over. */
export interface ImageRouteConfig {
  readonly image_provider: string;
  readonly image_model: string;
  readonly image_price_cents: number;
  readonly image_auto_approve_under_cents: number;
}

export interface ImageRoute {
  /** Who bills: the ledger's `provider`. */
  readonly provider: string;
  readonly kind: "gemini" | "openai-images";
  readonly model: string;
  readonly baseUrl: string;
  /** Integer cents for one image, known before the call. */
  readonly priceCents: number;
  /** The env var the key is read from. The name only, never the value. */
  readonly keyEnv: string;
  /** A runtime on the operator's own machine: no key needed, no charge. */
  readonly local: boolean;
}

export interface GeneratedImage {
  readonly bytes: Buffer;
  readonly mimeType: ImageMime;
}

function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const raw = env[name];
  return raw !== undefined && raw.trim() !== "" ? raw.trim() : undefined;
}

function configError(message: string, target: string): TrentError {
  return new TrentError({ code: EXIT.CONFIG, operation: "media.image", message, target });
}

/** The first Gemini key variable that is set, or nothing. */
export function geminiKeyEnv(env: NodeJS.ProcessEnv): string | undefined {
  return GEMINI_KEY_ENVS.find((name) => envValue(env, name) !== undefined);
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/**
 * Which provider, model, endpoint and price one call would use, from the profile and the env.
 * Throws a typed configuration error (exit code 3) that names the variable or the key to set;
 * it never guesses a model or a price for a provider whose list it cannot vouch for.
 */
export function resolveImageRoute(config: ImageRouteConfig, env: NodeJS.ProcessEnv): ImageRoute {
  let provider = config.image_provider.trim().toLowerCase();
  if (provider === "" || provider === "auto") {
    if (geminiKeyEnv(env) !== undefined) provider = "google";
    else if (envValue(env, "OPENAI_API_KEY") !== undefined) provider = "openai";
    else {
      throw configError(
        "no image provider has a key. Put GEMINI_API_KEY in <profile>/.env (or the shell) for the Gemini image model, or OPENAI_API_KEY with media.image_model and media.image_price_cents for an OpenAI-compatible images endpoint; media.image_provider pins one",
        "GEMINI_API_KEY",
      );
    }
  }
  if (provider === "google") {
    const keyEnv = geminiKeyEnv(env);
    if (keyEnv === undefined) throw configError("media.image_provider is google but no Gemini key is set: put GEMINI_API_KEY in <profile>/.env or change media.image_provider", "GEMINI_API_KEY");
    const model = config.image_model.trim() || DEFAULT_GEMINI_IMAGE_MODEL;
    const shipped = GEMINI_IMAGE_PRICE_CENTS[model];
    const priceCents = config.image_price_cents > 0 ? config.image_price_cents : shipped;
    if (priceCents === undefined) {
      throw configError(`no shipped price for ${model} (the table covers ${Object.keys(GEMINI_IMAGE_PRICE_CENTS).join(", ")}); set media.image_price_cents to its integer price per image`, model);
    }
    return { provider: "google", kind: "gemini", model, baseUrl: trimSlash(envValue(env, GEMINI_BASE_URL_ENV) ?? DEFAULT_GEMINI_BASE_URL), priceCents, keyEnv, local: false };
  }
  const alias = resolveProviderAlias(provider);
  if (alias === undefined && provider !== "openai") {
    throw configError(`media.image_provider ${provider} is not google, openai or an alias (${Object.keys(PROVIDER_ALIAS_ROUTES).join(", ")})`, provider);
  }
  const label = alias?.label ?? "OpenAI";
  const keyEnv = alias?.apiKeyEnv ?? "OPENAI_API_KEY";
  const local = alias?.local ?? false;
  if (!local && envValue(env, keyEnv) === undefined) throw configError(`media.image_provider is ${provider} but ${keyEnv} is not set: put it in <profile>/.env or change media.image_provider`, keyEnv);
  const model = config.image_model.trim();
  if (model === "") throw configError(`media.image_model is empty: name the image model ${label} serves at /images/generations (nothing is guessed for a non-Gemini provider)`, "media.image_model");
  const priceCents = config.image_price_cents;
  if (priceCents === 0 && !local) throw configError(`media.image_price_cents is 0: set the integer cents ${label} bills for one ${model} image, so the approval and the spend ledger can name it`, "media.image_price_cents");
  const baseUrl = alias ? aliasBaseUrl(alias.alias, env) : trimSlash(envValue(env, OPENAI_BASE_URL_ENV) ?? DEFAULT_OPENAI_BASE_URL);
  return { provider, kind: "openai-images", model, baseUrl, priceCents, keyEnv, local };
}

/** The generateContent body for one image; the aspect ratio goes as written, the size stays at 1K. */
export function buildGeminiImageRequest(prompt: string, aspect: ImageAspect): Record<string, unknown> {
  return {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: { responseModalities: ["IMAGE"], imageConfig: { aspectRatio: aspect, imageSize: GEMINI_IMAGE_SIZE } },
  };
}

/** OpenAI's three sizes: square, landscape, portrait. */
export function openAiImageSize(aspect: ImageAspect): string {
  if (aspect === "1:1") return "1024x1024";
  return aspect === "16:9" || aspect === "4:3" ? "1536x1024" : "1024x1536";
}

/** The images/generations body. `gpt-image` models refuse `response_format` and always answer base64; the others need it asked for. */
export function buildOpenAiImageRequest(model: string, prompt: string, aspect: ImageAspect): Record<string, unknown> {
  return { model, prompt, n: 1, size: openAiImageSize(aspect), ...(model.startsWith("gpt-image") ? {} : { response_format: "b64_json" }) };
}

interface GeminiPart {
  text?: string;
  inlineData?: { mimeType?: string; data?: string };
}

/** The first inline image of the first candidate, or the text the model answered instead. */
export function parseGeminiImage(json: unknown): { data: string } | { text: string } {
  const candidates = (json as { candidates?: Array<{ content?: { parts?: GeminiPart[] } }> } | undefined)?.candidates ?? [];
  const parts = candidates[0]?.content?.parts ?? [];
  const image = parts.find((part) => typeof part.inlineData?.data === "string" && part.inlineData.data !== "");
  if (image?.inlineData?.data) return { data: image.inlineData.data };
  const text = parts.map((part) => part.text ?? "").join(" ").trim();
  return { text };
}

export function parseOpenAiImage(json: unknown): { data: string } | { text: string } {
  const first = (json as { data?: Array<{ b64_json?: string; url?: string; revised_prompt?: string }> } | undefined)?.data?.[0];
  if (typeof first?.b64_json === "string" && first.b64_json !== "") return { data: first.b64_json };
  if (typeof first?.url === "string") return { text: "the endpoint answered with a URL instead of bytes; the tool downloads nothing, so use a model that returns b64_json" };
  return { text: "" };
}

function clipText(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length <= ERROR_TEXT_LIMIT ? line : `${line.slice(0, ERROR_TEXT_LIMIT - 3)}...`;
}

async function errorReason(response: Response): Promise<string> {
  try {
    const text = await response.text();
    try {
      const parsed = JSON.parse(text) as { error?: { message?: string } | string };
      const message = typeof parsed.error === "string" ? parsed.error : parsed.error?.message;
      return message ? clipText(message) : clipText(text);
    } catch {
      return clipText(text);
    }
  } catch {
    return "";
  }
}

export class ImageProviderError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "ImageProviderError";
  }
}

/** Sends one prompt to the route and returns the bytes. The key is read here and goes in a header. */
export async function generateImage(route: ImageRoute, input: { prompt: string; aspect: ImageAspect }, env: NodeJS.ProcessEnv, fetchImpl: FetchLike = fetch): Promise<GeneratedImage> {
  const key = envValue(env, route.keyEnv) ?? (route.local ? LOCAL_PLACEHOLDER_KEY : undefined);
  if (key === undefined) throw configError(`${route.keyEnv} is not set`, route.keyEnv);
  const gemini = route.kind === "gemini";
  const url = gemini ? `${route.baseUrl}/models/${encodeURIComponent(route.model)}:generateContent` : `${route.baseUrl}/images/generations`;
  const headers: Record<string, string> = gemini ? { "content-type": "application/json", "x-goog-api-key": key } : { "content-type": "application/json", authorization: `Bearer ${key}` };
  const body = gemini ? buildGeminiImageRequest(input.prompt, input.aspect) : buildOpenAiImageRequest(route.model, input.prompt, input.aspect);
  const response = await fetchImpl(url, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS) });
  if (!response.ok) {
    const reason = (await errorReason(response)).split(key).join("[redacted]");
    throw new ImageProviderError(`${route.provider} answered HTTP ${response.status}${reason ? `: ${reason}` : ""}`, response.status);
  }
  const parsed = gemini ? parseGeminiImage(await response.json()) : parseOpenAiImage(await response.json());
  if (!("data" in parsed)) throw new ImageProviderError(`${route.provider} ${route.model} answered with no image${parsed.text ? `: ${clipText(parsed.text)}` : ""}`);
  const bytes = Buffer.from(parsed.data, "base64");
  const mimeType = sniffImage(bytes);
  if (mimeType === null) throw new ImageProviderError(`${route.provider} ${route.model} answered with ${bytes.length} bytes that are not a PNG, JPEG, GIF or WebP; nothing was written`);
  return { bytes, mimeType };
}

const EXTENSIONS: Readonly<Record<ImageMime, string>> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };

/** `<first 16 hex of sha256>.<ext>`: the same bytes land under the same name, and a name never says what was asked for. */
export function imageFileName(bytes: Buffer, mimeType: ImageMime): string {
  return `${crypto.createHash("sha256").update(bytes).digest("hex").slice(0, 16)}.${EXTENSIONS[mimeType]}`;
}

export const BRIEF_VARIANTS = ["A", "B", "C"] as const;
export type BriefVariant = (typeof BRIEF_VARIANTS)[number];
const BRIEF_FIELD = /^(Composition|Text|Face|Colou?rs|Alt text|Shoot list|Generation prompt(?: \(for later\))?):/i;
const BRIEF_PROMPT = /^Generation prompt(?: \(for later\))?:\s*(.*)$/i;

/**
 * The "Generation prompt (for later)" paragraph under `## <variant>:` of a file the
 * `thumbnail-brief` skill wrote (`packages/trent-core/skills/thumbnail-brief/SKILL.md`, "Output
 * format"). The paragraph runs to the next blank line, field label or heading. Nothing when the
 * variant or its prompt is absent.
 */
export function briefPrompt(markdown: string, variant: BriefVariant): string | undefined {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((line) => new RegExp(`^##\\s+${variant}\\s*:`, "i").test(line));
  if (start === -1) return undefined;
  const collected: string[] = [];
  let inPrompt = false;
  for (const line of lines.slice(start + 1)) {
    if (/^##\s/.test(line)) break;
    if (inPrompt) {
      if (line.trim() === "" || BRIEF_FIELD.test(line)) break;
      collected.push(line.trim());
      continue;
    }
    const match = BRIEF_PROMPT.exec(line);
    if (match) {
      inPrompt = true;
      if (match[1]!.trim() !== "") collected.push(match[1]!.trim());
    }
  }
  const prompt = collected.join(" ").trim();
  return prompt === "" ? undefined : prompt;
}
