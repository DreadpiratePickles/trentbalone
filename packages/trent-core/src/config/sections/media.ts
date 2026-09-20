/**
 * The `media` block of `TrentConfigSchema`. Composed in `config/schema.ts`.
 */

import { z } from "zod";

/**
 * Where `media_image` sends a prompt: `auto` picks Gemini when its key is set, else OpenAI;
 * the last four are the alias table of `model-gateway/providers.ts`, named literally here the
 * way `sections/models.ts` names them (a config section imports no runtime module), and
 * `tools/media/image.test.ts` holds the two lists together.
 */
export const IMAGE_PROVIDERS = ["auto", "google", "openai", "ollama", "lmstudio", "deepseek", "groq"] as const;
export type ImageProvider = (typeof IMAGE_PROVIDERS)[number];

// [B2] media
/**
 * The local clip pipeline (docs/media.md). `backend` `auto` runs every media tool in the
 * `trent-sandbox-media:<v>` container when that image exists and on the host's own binaries
 * otherwise; `host` and `docker` force one. `hosted_transcription` is an explicit opt-in: when
 * no local whisper engine is installed, `media_transcribe` may send the audio to the configured
 * model provider, which is egress of private audio, so it is off by default, asks for approval
 * on every call, and `trent doctor` names it. `whisper_model` is the path of a whisper.cpp ggml
 * model file; empty means `<profile>/models/ggml-*.bin`, smallest first.
 *
 * [W4] Image generation (`media_image`, docs/media.md "Image generation") is metered external
 * spend. `image_provider` names who renders: `google` is the Gemini image model on the Gemini
 * key; `openai` and the aliases are an OpenAI-compatible `/images/generations` endpoint on that
 * provider's base URL and key. `image_model` is the model id; empty means the shipped Gemini
 * default and is refused for the other providers, whose catalogues change too often to ship a
 * guess. `image_price_cents` is the integer price of one image; 0 means the shipped Gemini
 * table, and is refused for a hosted non-Gemini provider. `image_auto_approve_under_cents` is
 * the one lift on the approval every image asks for: 0 (the default) asks every time; a
 * positive value lets an image strictly cheaper than it run unasked.
 */
export const MediaConfigSchema = z
  .object({
    backend: z.enum(["auto", "host", "docker"]).default("auto"),
    hosted_transcription: z.boolean().default(false),
    whisper_model: z.string().default(""),
    image_provider: z.enum(IMAGE_PROVIDERS).default("auto"),
    image_model: z.string().default(""),
    image_price_cents: z.number().int().min(0).default(0),
    image_auto_approve_under_cents: z.number().int().min(0).default(0),
  })
  .strict();

export type MediaConfig = z.infer<typeof MediaConfigSchema>;
