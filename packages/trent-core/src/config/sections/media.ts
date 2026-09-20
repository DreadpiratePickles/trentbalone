/**
 * The `media` block of `TrentConfigSchema`. Composed in `config/schema.ts`.
 */

import { z } from "zod";

// [B2] media
/**
 * The local clip pipeline (docs/media.md). `backend` `auto` runs every media tool in the
 * `trent-sandbox-media:<v>` container when that image exists and on the host's own binaries
 * otherwise; `host` and `docker` force one. `hosted_transcription` is an explicit opt-in: when
 * no local whisper engine is installed, `media_transcribe` may send the audio to the configured
 * model provider, which is egress of private audio, so it is off by default, asks for approval
 * on every call, and `trent doctor` names it. `whisper_model` is the path of a whisper.cpp ggml
 * model file; empty means `<profile>/models/ggml-*.bin`, smallest first.
 */
export const MediaConfigSchema = z
  .object({
    backend: z.enum(["auto", "host", "docker"]).default("auto"),
    hosted_transcription: z.boolean().default(false),
    whisper_model: z.string().default(""),
  })
  .strict();

export type MediaConfig = z.infer<typeof MediaConfigSchema>;
