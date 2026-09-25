/**
 * [P2-3] Voice notes on the gateway. A voice note sent on Telegram, WhatsApp, Signal, Discord or
 * Slack reaches `GatewayManager.handleInbound` as an `InboundMessage` whose `attachments` carry a
 * lazy `open()` (the adapter never downloads before the pairing gate). `prepareVoiceNote` is the one
 * call there, placed after that gate: for a paired sender it downloads the audio through the
 * adapter's own client into `<profile>/inbox/<platform>/<message-id>.<ext>` (0600, dir 0700), capped
 * at `gateway.voice_notes.max_bytes`, refuses a note longer than `gateway.voice_notes.max_seconds`,
 * transcribes it with the media toolset's engines (`tools/media/transcribe.ts`: whisper.cpp or
 * faster-whisper, on the host or in the `trent-sandbox-media` image, chosen exactly as
 * `media_transcribe` chooses), and hands the run `[voice note, <n>s] <transcript>`. The file stays
 * in the inbox, and its path rides on the attachment and in `metadata.voiceNotes`.
 *
 * Hosted transcription is never used here. `media_transcribe` sends audio off the machine only
 * after a per-call approval and writes the cost to the run's ledger; an inbound note has neither an
 * approver nor a run yet. With no local engine the sender is told what to install (the doctor's
 * hint) and nothing runs. No text is produced here that an engine did not produce.
 */
import fs from "node:fs";
import path from "node:path";
import type { ConfigManager } from "../config/ConfigManager.js";
import { GatewayConfigSchema } from "../config/sections/gateway.js";
import { mediaInstallHint } from "../doctor/checks/media.js";
import { selectMediaBackend, type MediaBackend, type MediaExec } from "../tools/media/backend.js";
import { parseProbe, probeArgs } from "../tools/media/commands.js";
import type { ResolvedPath } from "../tools/media/paths.js";
import { planEngine, transcribeMedia } from "../tools/media/transcribe.js";
import { SILENT_LOGGER, type AdapterLogger, type InboundAttachment, type InboundMessage } from "./transport/types.js";

const VOICE_NOTES_SCHEMA = GatewayConfigSchema.shape.voice_notes.unwrap();
const MAX_REASON_CHARS = 300;

export interface VoiceNoteSettings {
  enabled: boolean;
  maxSeconds: number;
  maxBytes: number;
}

/** `gateway.voice_notes`, with the schema's defaults when the block is absent. */
export function voiceNoteSettings(config: ConfigManager): VoiceNoteSettings {
  const parsed = VOICE_NOTES_SCHEMA.parse(config.loadConfig().gateway?.voice_notes ?? {});
  return { enabled: parsed.enabled, maxSeconds: parsed.max_seconds, maxBytes: parsed.max_bytes };
}

export function formatBytes(bytes: number): string {
  const mib = bytes / (1024 * 1024);
  return mib >= 1 ? `${bytes} bytes (${Number.isInteger(mib) ? mib : mib.toFixed(1)} MiB)` : `${bytes} bytes`;
}

export class VoiceNoteTooLarge extends Error {
  constructor(readonly maxBytes: number) {
    super(`the voice note is larger than ${formatBytes(maxBytes)}, the cap (gateway.voice_notes.max_bytes)`);
    this.name = "VoiceNoteTooLarge";
  }
}

const EXTENSIONS: Readonly<Record<string, string>> = {
  "audio/ogg": "ogg", "audio/opus": "opus", "audio/mpeg": "mp3", "audio/mp3": "mp3",
  "audio/mp4": "m4a", "audio/m4a": "m4a", "audio/x-m4a": "m4a", "audio/aac": "aac", "audio/x-aac": "aac",
  "audio/webm": "webm", "audio/wav": "wav", "audio/x-wav": "wav", "audio/wave": "wav", "audio/vnd.wave": "wav",
  "audio/amr": "amr", "audio/3gpp": "3gp", "audio/flac": "flac", "audio/x-flac": "flac", "audio/aiff": "aiff", "audio/x-aiff": "aiff",
};

/** The file extension for a declared MIME type; `audio` when the type is not one we know (ffmpeg sniffs content anyway). */
export function extensionForMime(mime: string): string {
  return EXTENSIONS[(mime.split(";")[0] ?? "").trim().toLowerCase()] ?? "audio";
}

/** A platform message id as a file stem: word characters and dashes only, so it can never leave the inbox. */
function safeStem(id: string): string {
  const stem = id.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 120);
  return stem === "" ? "message" : stem;
}

export function inboxDir(profileDir: string, platform: string): string {
  return path.join(profileDir, "inbox", safeStem(platform));
}

export interface SaveVoiceNoteOptions {
  profileDir: string;
  platform: string;
  messageId: string;
  /** Position among the message's audio attachments; the second one is `<id>-2.<ext>`. */
  index?: number;
  maxBytes: number;
}

async function readCapped(attachment: InboundAttachment, maxBytes: number, platform: string): Promise<Uint8Array> {
  if (!attachment.open) throw new Error(`${platform}: the voice note carries nothing to download`);
  const res = await attachment.open();
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    throw new Error(`${platform}: voice note download failed: HTTP ${res.status}`);
  }
  const declared = Number(res.headers.get("content-length") ?? Number.NaN);
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => undefined);
    throw new VoiceNoteTooLarge(maxBytes);
  }
  if (!res.body) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new VoiceNoteTooLarge(maxBytes);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * Downloads one audio attachment (or takes its inline bytes) into the profile inbox and returns the
 * path. Refuses with {@link VoiceNoteTooLarge} past `maxBytes`, declared or streamed, and then writes
 * nothing: the bytes are held until the cap is known to hold, so no partial file is ever left.
 */
export async function saveVoiceNote(attachment: InboundAttachment, options: SaveVoiceNoteOptions): Promise<string> {
  if (attachment.sizeBytes !== undefined && attachment.sizeBytes > options.maxBytes) throw new VoiceNoteTooLarge(options.maxBytes);
  const bytes = attachment.bytes ?? (await readCapped(attachment, options.maxBytes, options.platform));
  if (bytes.byteLength > options.maxBytes) throw new VoiceNoteTooLarge(options.maxBytes);
  const dir = inboxDir(options.profileDir, options.platform);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const suffix = options.index ? `-${options.index + 1}` : "";
  const file = path.join(dir, `${safeStem(options.messageId)}${suffix}.${extensionForMime(attachment.mime)}`);
  fs.writeFileSync(file, bytes, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return file;
}

export type VoiceTranscription = { ok: true; text: string; engine: string; durationSeconds?: number } | { ok: false; reason: string };

/** The engine seam: the media toolset's engines by default, a fake in tests. */
export interface VoiceEngine {
  /** Undefined when a local engine can transcribe here; otherwise what to install, as the doctor says it. */
  missing(): Promise<string | undefined>;
  /** Seconds of audio in `file`, or undefined when nothing on this machine can tell. */
  duration(file: string): Promise<number | undefined>;
  transcribe(file: string): Promise<VoiceTranscription>;
}

export interface VoiceEngineContext {
  profileDir: string;
  /** The platform's inbox directory; the media backend's workspace (the only directory a container sees). */
  workspace: string;
  /** `config.media`: which backend, which whisper.cpp model. */
  media?: { backend?: "auto" | "host" | "docker"; whisper_model?: string };
  env?: NodeJS.ProcessEnv;
  exec?: MediaExec;
}

export type VoiceEngineFactory = (ctx: VoiceEngineContext) => VoiceEngine;

/** The media toolset's engines, resolved as `media_transcribe` resolves them, minus the hosted path. */
export function createMediaVoiceEngine(ctx: VoiceEngineContext): VoiceEngine {
  let backendPromise: Promise<MediaBackend> | undefined;
  const backend = (): Promise<MediaBackend> => {
    backendPromise ??= selectMediaBackend({ workspace: ctx.workspace, backend: ctx.media?.backend ?? "auto", ...(ctx.env ? { env: ctx.env } : {}), ...(ctx.exec ? { exec: ctx.exec } : {}) });
    return backendPromise;
  };
  const whisperModel = ctx.media?.whisper_model ?? "";
  const resolved = (file: string): ResolvedPath => ({ host: file, rel: path.relative(ctx.workspace, file).split(path.sep).join("/") });
  return {
    async missing() {
      const be = await backend();
      const plan = await planEngine({ backend: be, profileDir: ctx.profileDir, whisperModel, hostedAllowed: false });
      const lacking = [...(plan.engine === "none" ? ["whisper-cli"] : []), ...((await be.installed()).ffmpeg ? [] : ["ffmpeg"])];
      return lacking.length === 0 ? undefined : mediaInstallHint(lacking);
    },
    async duration(file) {
      const result = await (await backend()).run("ffprobe", probeArgs(resolved(file).rel), { timeoutMs: 60_000 });
      return result.code === 0 ? parseProbe(result.stdout)?.durationSeconds : undefined;
    },
    async transcribe(file) {
      const result = await transcribeMedia({ backend: await backend(), workspace: ctx.workspace, profileDir: ctx.profileDir, input: resolved(file), whisperModel, hostedAllowed: false });
      if (!result.ok) return { ok: false, reason: result.reason };
      const segments = result.transcript.segments;
      const text = segments.map((s) => s.text.trim()).filter((t) => t !== "").join(" ");
      const end = segments.reduce((max, s) => Math.max(max, s.end), 0);
      return { ok: true, text, engine: result.transcript.engine, ...(end > 0 ? { durationSeconds: end } : {}) };
    },
  };
}

/** What `GatewayManager` is constructed with; every field is optional. */
export interface VoiceNoteOptions {
  /** Builds the engine for one message; defaults to {@link createMediaVoiceEngine}. */
  engine?: VoiceEngineFactory;
  /** PATH and environment for the media binaries; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  exec?: MediaExec;
  logger?: AdapterLogger;
}

/** The message to run (its text now the transcript), or the one reply the sender gets instead of a run. */
export type PreparedInbound = { ok: true; message: InboundMessage } | { ok: false; reply: string };

export function voiceNoteLabel(seconds: number | undefined): string {
  return seconds === undefined || !Number.isFinite(seconds) || seconds <= 0 ? "[voice note]" : `[voice note, ${Math.max(1, Math.round(seconds))}s]`;
}

const tooLong = (seconds: number, max: number): string =>
  `This voice note is ${Math.ceil(seconds)} s long; Trent transcribes voice notes of up to ${max} s (gateway.voice_notes.max_seconds), so it was not run. Send a shorter one, or type it.`;
const tooBig = (maxBytes: number): string =>
  `This voice note is larger than ${formatBytes(maxBytes)}, the cap on a voice note (gateway.voice_notes.max_bytes), so it was not run. Send a shorter one, or type it.`;
const turnedOff = "Voice notes are turned off here (gateway.voice_notes.enabled is false), so this one was not run. Send it as text.";

function discard(file: string): void {
  fs.rmSync(file, { force: true });
}

/**
 * Turns a paired sender's voice note into the text the run sees. A message without audio comes back
 * untouched. Call it only after the pairing gate: it downloads.
 */
export async function prepareVoiceNote(message: InboundMessage, config: ConfigManager, options: VoiceNoteOptions = {}): Promise<PreparedInbound> {
  const audio = (message.attachments ?? []).filter((a) => a.kind === "audio");
  if (audio.length === 0) return { ok: true, message };
  const settings = voiceNoteSettings(config);
  if (!settings.enabled) return message.content.trim() !== "" ? { ok: true, message } : { ok: false, reply: turnedOff };
  for (const a of audio) {
    if (a.durationSeconds !== undefined && a.durationSeconds > settings.maxSeconds) return { ok: false, reply: tooLong(a.durationSeconds, settings.maxSeconds) };
    if (a.sizeBytes !== undefined && a.sizeBytes > settings.maxBytes) return { ok: false, reply: tooBig(settings.maxBytes) };
  }

  const logger = options.logger ?? SILENT_LOGGER;
  const profileDir = config.getProfileDir();
  const workspace = inboxDir(profileDir, message.platform);
  fs.mkdirSync(workspace, { recursive: true, mode: 0o700 });
  const media = config.loadConfig().media;
  const context: VoiceEngineContext = { profileDir, workspace, media: { backend: media?.backend, whisper_model: media?.whisper_model }, ...(options.env ? { env: options.env } : {}), ...(options.exec ? { exec: options.exec } : {}) };
  const engine = (options.engine ?? createMediaVoiceEngine)(context);
  const hint = await engine.missing();
  if (hint !== undefined) return { ok: false, reply: `This voice note was not run: there is no local speech-to-text engine on this machine to transcribe it. ${hint}` };

  const lines: string[] = [];
  const saved: InboundAttachment[] = [];
  const records: Array<{ path: string; durationSeconds?: number; engine: string }> = [];
  for (const [index, attachment] of audio.entries()) {
    let file: string;
    try {
      file = await saveVoiceNote(attachment, { profileDir, platform: message.platform, messageId: message.id, index, maxBytes: settings.maxBytes });
    } catch (err) {
      if (err instanceof VoiceNoteTooLarge) return { ok: false, reply: tooBig(settings.maxBytes) };
      logger.warn("gateway.voice_note.download_failed", { platform: message.platform, messageId: message.id, error: err instanceof Error ? err.message : String(err) });
      return { ok: false, reply: `This voice note could not be downloaded from ${message.platform}, so it was not run. Try sending it again.` };
    }
    const length = attachment.durationSeconds ?? (await engine.duration(file));
    if (length !== undefined && length > settings.maxSeconds) {
      discard(file);
      return { ok: false, reply: tooLong(length, settings.maxSeconds) };
    }
    const result = await engine.transcribe(file);
    if (!result.ok) {
      discard(file);
      return { ok: false, reply: `This voice note could not be transcribed (${result.reason.slice(0, MAX_REASON_CHARS)}), so it was not run.` };
    }
    if (result.text.trim() === "") {
      discard(file);
      return { ok: false, reply: "No speech was found in this voice note, so it was not run." };
    }
    const seconds = length ?? result.durationSeconds;
    lines.push(`${voiceNoteLabel(seconds)} ${result.text.trim()}`);
    saved.push({ ...attachment, path: file, ...(seconds !== undefined ? { durationSeconds: seconds } : {}) });
    records.push({ path: file, engine: result.engine, ...(seconds !== undefined ? { durationSeconds: seconds } : {}) });
  }
  if (message.content.trim() !== "") lines.push(message.content);
  const others = (message.attachments ?? []).filter((a) => a.kind !== "audio");
  return {
    ok: true,
    message: { ...message, content: lines.join("\n"), attachments: [...saved, ...others], metadata: { ...(message.metadata ?? {}), voiceNotes: records } },
  };
}
