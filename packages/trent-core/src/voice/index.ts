/**
 * T0.5 — voice transcription is not available in this release.
 *
 * The previous module spawned a `python3 -c print(...)` "sidecar" and answered every transcription
 * request with a fabricated `Transcribed N bytes of audio` string: output-shaped text that no model
 * or speech engine ever produced (AGENTS.md invariant 2). It is gone. This is the single entry point
 * any surface may call, and the only thing it does is refuse honestly with a TrentError.
 */
import { EXIT, TrentError } from "../errors/index.js";

export const VOICE_OPERATION = "voice.transcribe";

/**
 * Always throws. Accepts the audio so a caller's signature does not change when a real speech
 * engine is wired in; the bytes are never read.
 */
export function transcribeVoice(_audio?: Uint8Array): never {
  throw new TrentError({
    code: EXIT.USAGE,
    operation: VOICE_OPERATION,
    message: "voice transcription is not available in this release",
  });
}
