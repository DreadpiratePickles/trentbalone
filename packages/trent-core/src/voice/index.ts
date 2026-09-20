/**
 * Voice transcription: the media toolset's transcription backend (`tools/media/transcribe.ts`)
 * applied to a byte buffer a surface recorded.
 *
 * The previous module answered every request with a fabricated `Transcribed N bytes of audio`
 * string (AGENTS.md invariant 2); the release after it refused every request. This one runs the
 * same engines `media_transcribe` runs: whisper.cpp or faster-whisper on the host (or in the
 * media container when its image exists), and the hosted provider only when
 * `media.hosted_transcription` opted in, because that sends the audio off the machine. With no
 * engine it throws a TrentError naming what to install. The bytes are written to a private
 * scratch workspace under the profile (`cache/voice/`), transcribed there, and removed.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EXIT, TrentError } from "../errors/index.js";
import { selectMediaBackend, type MediaExec } from "../tools/media/backend.js";
import { transcribeMedia, type Transcript, type TranscriptionGateway } from "../tools/media/transcribe.js";

export const VOICE_OPERATION = "voice.transcribe";
export type { Transcript as VoiceTranscript } from "../tools/media/transcribe.js";

export interface TranscribeVoiceOptions {
  /** The profile directory: where models are looked up and where the scratch workspace lives. */
  readonly profileDir: string;
  /** `config.media`; absent means `auto` backend, no hosted path, no configured model. */
  readonly media?: { readonly backend?: "auto" | "host" | "docker"; readonly hosted_transcription?: boolean; readonly whisper_model?: string };
  readonly gateway?: TranscriptionGateway;
  readonly language?: string;
  /** Environment for the PATH lookup; defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
  readonly exec?: MediaExec;
}

/** Transcribes recorded audio bytes (wav, mp3, m4a, ogg: whatever ffmpeg reads) to timestamped segments. */
export async function transcribeVoice(audio: Uint8Array, options: TranscribeVoiceOptions): Promise<Transcript> {
  if (audio.length === 0) {
    throw new TrentError({ code: EXIT.USAGE, operation: VOICE_OPERATION, message: "no audio bytes were given" });
  }
  const scratchRoot = path.join(options.profileDir, "cache", "voice");
  fs.mkdirSync(scratchRoot, { recursive: true, mode: 0o700 });
  const workspace = fs.mkdtempSync(path.join(scratchRoot, "rec-"));
  try {
    const file = path.join(workspace, "recording.audio");
    fs.writeFileSync(file, audio, { mode: 0o600 });
    const backend = await selectMediaBackend({ workspace, backend: options.media?.backend ?? "auto", ...(options.env ? { env: options.env } : {}), ...(options.exec ? { exec: options.exec } : {}) });
    const result = await transcribeMedia({
      backend,
      workspace,
      profileDir: options.profileDir,
      input: { host: fs.realpathSync(file), rel: "recording.audio" },
      whisperModel: options.media?.whisper_model ?? "",
      hostedAllowed: options.media?.hosted_transcription === true,
      ...(options.language ? { language: options.language } : {}),
      ...(options.gateway ? { gateway: options.gateway } : {}),
    });
    if (!result.ok) {
      throw new TrentError({ code: EXIT.CONFIG, operation: VOICE_OPERATION, message: `voice transcription is not available: ${result.reason}` });
    }
    return result.transcript;
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

/** The scratch directory a surface may clean; exported so the doctor can name it. */
export function voiceScratchDir(profileDir: string = path.join(os.homedir(), ".trent", "default")): string {
  return path.join(profileDir, "cache", "voice");
}
