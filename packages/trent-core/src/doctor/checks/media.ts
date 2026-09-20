/**
 * The media line (B2, G8): which backend `media_*` would run on, which of the allowlisted
 * binaries are present, how to install the rest on this OS, and, when the profile opted in,
 * that hosted transcription sends a file's audio to the model provider. The probe is the same
 * one the toolset uses to choose its backend (`tools/media/backend.ts`), so the doctor reports
 * what a call would do, not what a YAML file claims. [W4] One more sentence names where
 * `media_image` would send a prompt, what one image costs and whether it asks, resolved by the
 * same `resolveImageRoute` the tool uses; the key's value is never read here.
 */
import { isTrentError } from "../../errors/TrentError.js";
import { MEDIA_BINARIES, MEDIA_IMAGE, mediaBuildCommand, reportMediaInstall, type MediaExec } from "../../tools/media/backend.js";
import { resolveImageRoute, type ImageRouteConfig } from "../../tools/media/image.js";
import { findWhisperModel } from "../../tools/media/transcribe.js";
import { DEFAULT_PROBE_TIMEOUT_MS, runCommand } from "../probe.js";
import type { CheckResult, DoctorCheck, DoctorContext } from "../types.js";

const CATEGORY = "Media";
const NAME = "Media Pipeline";

function result(partial: Omit<CheckResult, "category" | "name">): CheckResult {
  return { category: CATEGORY, name: NAME, ...partial };
}

/** One install line per OS for what is missing; the media image covers everything at once. */
export function mediaInstallHint(missing: readonly string[]): string {
  const lines: string[] = [];
  if (missing.includes("ffmpeg") || missing.includes("ffprobe")) lines.push("ffmpeg (ffprobe comes with it): macOS `brew install ffmpeg`; Debian/Ubuntu `sudo apt install ffmpeg`; Windows `winget install Gyan.FFmpeg`.");
  if (missing.includes("whisper-cli")) lines.push("whisper.cpp: macOS `brew install whisper-cpp`; elsewhere build https://github.com/ggml-org/whisper.cpp and put whisper-cli on PATH. Then download a ggml model (ggml-base.en.bin from huggingface.co/ggerganov/whisper.cpp) into <profile>/models/ or set media.whisper_model. Alternative: `pip install faster-whisper`.");
  if (missing.includes("scenedetect")) lines.push("PySceneDetect: `pip install scenedetect[opencv]` (optional; ffmpeg's scene filter is the fallback).");
  if (missing.includes("python3")) lines.push("python3: macOS `brew install python`; Debian/Ubuntu `sudo apt install python3`; needed for faster-whisper, scenedetect and MediaPipe face tracking (`pip install mediapipe`).");
  lines.push(`Or build the media image once with \`${mediaBuildCommand()}\` (${MEDIA_IMAGE}: ffmpeg, whisper.cpp with a base model, scenedetect, mediapipe) and every tool runs in a container with no network.`);
  return lines.join(" ");
}

/** The image sentence and its details: the route, or the configuration error that stops it. */
export function describeImageRoute(media: ImageRouteConfig, env: NodeJS.ProcessEnv): { line: string; details: Record<string, unknown> } {
  try {
    const route = resolveImageRoute(media, env);
    const asks = media.image_auto_approve_under_cents > 0 && route.priceCents < media.image_auto_approve_under_cents ? `runs without asking (under media.image_auto_approve_under_cents ${media.image_auto_approve_under_cents})` : "asks for approval on every call";
    return {
      line: ` Image generation (media_image): ${route.provider} ${route.model} at ${route.priceCents} cents per image on ${route.keyEnv}, ${asks}.`,
      details: { provider: route.provider, model: route.model, priceCents: route.priceCents, keyEnv: route.keyEnv, autoApproveUnderCents: media.image_auto_approve_under_cents },
    };
  } catch (error) {
    if (!isTrentError(error)) throw error;
    return { line: ` Image generation (media_image) is not configured: ${error.message}.`, details: { provider: null, error: error.message } };
  }
}

export const checkMedia: DoctorCheck = {
  id: "check_media",
  name: NAME,
  category: CATEGORY,
  async run(ctx: DoctorContext): Promise<CheckResult> {
    const config = ctx.configManager.loadConfig();
    const media = config.media ?? { backend: "auto", hosted_transcription: false, whisper_model: "", image_provider: "auto", image_model: "", image_price_cents: 0, image_auto_approve_under_cents: 0 };
    const env = ctx.env ?? process.env;
    const timeoutMs = ctx.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
    const exec: MediaExec = async (command, args) => {
      const run = ctx.execImpl ?? runCommand;
      return run(command, args, timeoutMs);
    };
    const report = await reportMediaInstall(env, exec);
    const present = MEDIA_BINARIES.filter((name) => report.host[name]);
    const missing = MEDIA_BINARIES.filter((name) => !report.host[name]);
    const model = findWhisperModel(ctx.configManager.getProfileDir(), media.whisper_model);
    const forced = media.backend !== "auto" ? media.backend : undefined;
    const backend = forced ?? report.backend;
    const hosted = media.hosted_transcription === true;
    const imageRoute = describeImageRoute(media, env);
    const details = {
      backend,
      configured: media.backend,
      image: MEDIA_IMAGE,
      imagePresent: report.image,
      present,
      missing,
      whisperModel: model ?? null,
      hostedTranscription: hosted,
      imageGeneration: imageRoute.details,
    };
    const hostedLine =
      (hosted
        ? " hosted transcription is ON (media.hosted_transcription): when no local whisper engine answers, media_transcribe sends the file's audio to the configured model provider after an approval; that audio leaves this machine."
        : " Hosted transcription is off; no audio leaves this machine.") + imageRoute.line;

    if (backend === "none") {
      return result({
        status: "warn",
        message: `No media backend: ffmpeg and ffprobe are not on PATH and the ${MEDIA_IMAGE} image is not built, so the media toolset (probe, transcribe, scenes, clip, thumbnail) cannot run.${hostedLine}`,
        fixHint: mediaInstallHint(missing),
        details,
      });
    }
    if (backend === "docker") {
      return result({
        status: hosted ? "warn" : "ok",
        message: `Media tools run in the ${MEDIA_IMAGE} container (docker backend${forced ? ", forced by media.backend" : ""}): ffmpeg, whisper.cpp with its bundled model, scenedetect and mediapipe, no network.${hostedLine}`,
        ...(hosted ? { fixHint: "Set media.hosted_transcription to false to keep every transcription local." } : {}),
        details,
      });
    }
    const transcription = present.includes("whisper-cli")
      ? model
        ? `whisper.cpp with ${model}`
        : "whisper-cli is installed but no ggml model was found"
      : present.includes("python3")
        ? "faster-whisper if its Python module is installed, else none"
        : "none";
    return result({
      status: hosted ? "warn" : "ok",
      message: `Media tools run on the host backend${forced ? " (forced by media.backend)" : ""}: present ${present.join(", ")}; missing ${missing.join(", ") || "nothing"}; transcription: ${transcription}.${hostedLine}`,
      fixHint: missing.length > 0 || !model ? mediaInstallHint(model ? missing : [...new Set([...missing, "whisper-cli"])]) : undefined,
      details,
    });
  },
};
