/**
 * The `media` toolset (design B2, gate G8): the local clip pipeline over allowlisted binaries.
 *
 *   media_probe       ffprobe
 *   media_transcribe  ffmpeg -> whisper.cpp | faster-whisper | (opt-in, approved) hosted provider
 *   media_scenes      PySceneDetect | ffmpeg scene filter
 *   media_clip        ffmpeg cut, 9:16 crop (MediaPipe face track or centre), burned captions
 *   media_thumbnail   ffmpeg frame extraction
 *
 * The backend (`backend.ts`) is docker when `trent-sandbox-media:<v>` exists and the host's own
 * binaries otherwise; it is chosen on the first call. Every path the model names is declared a
 * path argument (`schemas.ts`) and confined to the workspace (`paths.ts`) before any binary is
 * spawned; every argv is built by `commands.ts`. Outputs never leave the workspace.
 */
import fs from "node:fs";
import path from "node:path";
import { parseAction, record, stringArg } from "../action.js";
import { fitSummary } from "../spillover.js";
import type { ToolCallRecord, ToolContext, TrentToolAdapter } from "../types.js";
import { renderToolInstructions } from "../web/schemas.js";
import { findOnPath, selectMediaBackend, type MediaBackend, type MediaExec } from "./backend.js";
import {
  clipArgs, faceTrackArgs, parseProbe, parseSceneCsv, parseSceneFilterTimes, portraitCrop, probeArgs, renderSegments, sceneDetectArgs, sceneFilterArgs,
  seconds, srtForWindow, thumbnailArgs, type CropBox, type MediaProbe, type TranscriptSegment,
} from "./commands.js";
import { MEDIA_OUTPUT_DIR, resolveInputPath, resolveOutputPath, stemOf, type PathResolution, type ResolvedPath } from "./paths.js";
import { MEDIA_ADAPTER_NAME, MEDIA_ROUTING_TEXT, MEDIA_SPECS, MEDIA_TOOL_NAMES, MEDIA_TOOL_SCHEMAS } from "./schemas.js";
import { findWhisperModel, transcribeMedia, type Transcript, type TranscriptionGateway } from "./transcribe.js";

export { MEDIA_ADAPTER_NAME, MEDIA_ROUTING_TEXT, MEDIA_TOOL_NAMES, MEDIA_TOOL_SCHEMAS } from "./schemas.js";
export * from "./backend.js";
export { MEDIA_OUTPUT_DIR, resolveInputPath, resolveOutputPath } from "./paths.js";
export { findWhisperModel, planEngine, transcribeMedia, MEDIA_IMAGE_MODEL } from "./transcribe.js";
export type { Transcript, TranscriptEngine, TranscribeResult } from "./transcribe.js";
export type { TranscriptSegment } from "./commands.js";

export const MEDIA_SCOPES: readonly string[] = [MEDIA_ADAPTER_NAME, ...MEDIA_TOOL_NAMES];
/** MediaPipe's face detector asset, beside the whisper models. */
export const FACE_MODEL_ASSET = "blaze_face_short_range.tflite";
const IMAGE_FACE_MODEL = `/opt/trent/models/${FACE_MODEL_ASSET}`;
const DEFAULT_SCENE_THRESHOLD = 0.3;
const MAX_CLIP_SECONDS = 60 * 60;

export interface MediaAdapterOptions {
  /** `config.media`. */
  readonly media?: { readonly backend?: "auto" | "host" | "docker"; readonly hosted_transcription?: boolean; readonly whisper_model?: string };
  /** The gateway hosted transcription would use; absent means the hosted path is never available. */
  readonly gateway?: TranscriptionGateway;
  /** The environment for PATH lookup and the child processes; defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
  /** Test seam for the docker CLI and the binaries. */
  readonly exec?: MediaExec;
}

function numberArg(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
  return Number.isFinite(n) ? n : undefined;
}

function refusal(action: string, tool: string, resolution: Exclude<PathResolution, { ok: true }>): ToolCallRecord {
  return record(MEDIA_ADAPTER_NAME, action, resolution.status, `${tool} refused: ${resolution.reason}`);
}

export function createMediaAdapter(ctx: ToolContext, options: MediaAdapterOptions = {}): TrentToolAdapter {
  const env = options.env ?? process.env;
  const hostedAllowed = options.media?.hosted_transcription === true;
  const whisperModel = options.media?.whisper_model ?? "";
  const fail = (action: string, summary: string): ToolCallRecord => record(MEDIA_ADAPTER_NAME, action, "failed", summary);
  let backendPromise: Promise<MediaBackend> | undefined;
  const backend = (): Promise<MediaBackend> => {
    backendPromise ??= selectMediaBackend({ workspace: ctx.workspace, env, backend: options.media?.backend ?? "auto", ...(options.exec ? { exec: options.exec } : {}) });
    return backendPromise;
  };

  function input(action: string, tool: string, args: Record<string, unknown>): { ok: true; path: ResolvedPath } | { ok: false; record: ToolCallRecord } {
    const raw = stringArg(args, "input");
    if (!raw) return { ok: false, record: fail(action, `${tool} needs {"input": "<path under the workspace>"}`) };
    const resolved = resolveInputPath(ctx.workspace, raw);
    return resolved.ok ? resolved : { ok: false, record: refusal(action, tool, resolved) };
  }

  function output(action: string, tool: string, raw: string | undefined, fallback: string): { ok: true; path: ResolvedPath } | { ok: false; record: ToolCallRecord } {
    const resolved = resolveOutputPath(ctx.workspace, raw, fallback);
    return resolved.ok ? resolved : { ok: false, record: refusal(action, tool, resolved) };
  }

  async function probeFile(rel: string): Promise<{ probe?: MediaProbe; error?: string }> {
    const result = await (await backend()).run("ffprobe", probeArgs(rel), { timeoutMs: 60_000 });
    if (result.code !== 0) return { error: `ffprobe exited ${result.code}: ${result.stderr.trim().split("\n").pop() ?? ""}` };
    const probe = parseProbe(result.stdout);
    return probe ? { probe } : { error: "ffprobe did not answer with JSON" };
  }

  function renderProbe(rel: string, probe: MediaProbe): string {
    const streams = probe.streams.map((s) => {
      const detail = s.kind === "video" ? `${s.width ?? "?"}x${s.height ?? "?"}${s.fps ? ` ${s.fps} fps` : ""}` : s.kind === "audio" ? `${s.sampleRate ?? "?"} Hz ${s.channels ?? "?"} ch` : "";
      return `  ${s.kind}: ${s.codec}${detail ? ` ${detail}` : ""}`;
    });
    const duration = probe.durationSeconds === undefined ? "unknown" : `${probe.durationSeconds.toFixed(2)} s`;
    return `${rel}: ${probe.container}, duration ${duration}${probe.sizeBytes !== undefined ? `, ${probe.sizeBytes} bytes` : ""}\nstreams:\n${streams.join("\n") || "  (none)"}`;
  }

  async function probe(action: string, args: Record<string, unknown>): Promise<ToolCallRecord> {
    const file = input(action, "media_probe", args);
    if (!file.ok) return file.record;
    const { probe: result, error } = await probeFile(file.path.rel);
    if (!result) return fail(action, `media_probe failed: ${error ?? "unknown"}`);
    return record(MEDIA_ADAPTER_NAME, action, "completed", renderProbe(file.path.rel, result));
  }

  async function transcribe(action: string, args: Record<string, unknown>): Promise<ToolCallRecord> {
    const file = input(action, "media_transcribe", args);
    if (!file.ok) return file.record;
    const out = output(action, "media_transcribe", stringArg(args, "output"), `${stemOf(file.path.rel)}.transcript.json`);
    if (!out.ok) return out.record;
    const language = stringArg(args, "language")?.trim();
    if (language !== undefined && language !== "" && !/^[a-z]{2,3}$/i.test(language)) return fail(action, "media_transcribe language must be a two- or three-letter code");
    const result = await transcribeMedia({
      backend: await backend(), workspace: ctx.workspace, profileDir: ctx.profileDir, input: file.path, whisperModel, hostedAllowed,
      ...(language ? { language } : {}), ...(options.gateway ? { gateway: options.gateway } : {}),
    });
    if (!result.ok) return fail(action, `media_transcribe failed: ${result.reason}`);
    fs.writeFileSync(out.path.host, `${JSON.stringify(result.transcript, null, 2)}\n`);
    const head = `${file.path.rel}: ${result.transcript.segments.length} segments by ${result.transcript.engine}${result.transcript.language ? ` (${result.transcript.language})` : ""}; saved ${out.path.rel}`;
    return record(MEDIA_ADAPTER_NAME, action, "completed", fitSummary(`${head}\n${renderSegments(result.transcript.segments)}`, ctx.profileDir, "media_transcribe"));
  }

  async function scenes(action: string, args: Record<string, unknown>): Promise<ToolCallRecord> {
    const file = input(action, "media_scenes", args);
    if (!file.ok) return file.record;
    const threshold = numberArg(args, "threshold") ?? DEFAULT_SCENE_THRESHOLD;
    if (threshold < 0 || threshold > 1) return fail(action, "media_scenes threshold must be between 0 and 1");
    const out = output(action, "media_scenes", undefined, `${stemOf(file.path.rel)}.scenes.json`);
    if (!out.ok) return out.record;
    const be = await backend();
    let cuts: number[];
    let engine: string;
    if ((await be.installed()).scenedetect) {
      const csvName = `${stemOf(file.path.rel)}.scenes.csv`;
      const result = await be.run("scenedetect", sceneDetectArgs({ input: file.path.rel, outDir: MEDIA_OUTPUT_DIR, csvName }));
      const csvPath = path.join(ctx.workspace, MEDIA_OUTPUT_DIR, csvName);
      const rows = fs.existsSync(csvPath) ? parseSceneCsv(fs.readFileSync(csvPath, "utf8")) : [];
      if (result.code !== 0 || rows.length === 0) return fail(action, `media_scenes failed: scenedetect exited ${result.code}: ${result.stderr.trim().split("\n").pop() ?? ""}`);
      cuts = rows.slice(1).map((row) => row.start);
      engine = "PySceneDetect";
    } else {
      const result = await be.run("ffmpeg", sceneFilterArgs(file.path.rel, threshold));
      if (result.code !== 0) return fail(action, `media_scenes failed: ffmpeg exited ${result.code}: ${result.stderr.trim().split("\n").pop() ?? ""}`);
      cuts = parseSceneFilterTimes(result.stderr).filter((t) => t > 0);
      engine = "ffmpeg scene filter";
    }
    fs.writeFileSync(out.path.host, `${JSON.stringify({ engine, threshold, cuts }, null, 2)}\n`);
    const lines = cuts.map((t, i) => `  cut ${i + 1}: ${t.toFixed(2)} s`);
    return record(MEDIA_ADAPTER_NAME, action, "completed", fitSummary(`${file.path.rel}: ${cuts.length} cut points by ${engine}; saved ${out.path.rel}\n${lines.join("\n") || "  (no cuts found)"}`, ctx.profileDir, "media_scenes"));
  }

  function readTranscript(raw: string | undefined, stem: string): { segments?: readonly TranscriptSegment[]; error?: string } {
    const resolved = resolveInputPath(ctx.workspace, raw ?? `${MEDIA_OUTPUT_DIR}/${stem}.transcript.json`);
    if (!resolved.ok) return { error: resolved.reason };
    try {
      const parsed = JSON.parse(fs.readFileSync(resolved.path.host, "utf8")) as Partial<Transcript>;
      if (!Array.isArray(parsed.segments)) return { error: `${resolved.path.rel} holds no segments` };
      return { segments: parsed.segments };
    } catch (error) {
      return { error: `${resolved.path.rel}: ${(error as Error).message}` };
    }
  }

  async function faceCentre(be: MediaBackend, rel: string, start: number, end: number): Promise<number | undefined> {
    const hostAsset = path.join(ctx.profileDir, "models", FACE_MODEL_ASSET);
    const asset = be.kind === "docker" ? { arg: IMAGE_FACE_MODEL, mounts: [] } : fs.existsSync(hostAsset) ? be.modelRef(hostAsset) : undefined;
    if (!asset || !(await be.installed()).python3) return undefined;
    const result = await be.run("python3", faceTrackArgs({ input: rel, start, end, modelAsset: asset.arg }), { readOnlyMounts: asset.mounts });
    if (result.code !== 0) return undefined;
    try {
      const parsed = JSON.parse(result.stdout.trim().split("\n").pop() ?? "") as { cx?: number | null };
      return typeof parsed.cx === "number" ? parsed.cx : undefined;
    } catch {
      return undefined;
    }
  }

  async function clip(action: string, args: Record<string, unknown>): Promise<ToolCallRecord> {
    const file = input(action, "media_clip", args);
    if (!file.ok) return file.record;
    const start = numberArg(args, "start");
    const end = numberArg(args, "end");
    if (start === undefined || end === undefined || start < 0 || end <= start || end - start > MAX_CLIP_SECONDS) return fail(action, "media_clip needs start and end in seconds, with end after start and a window of at most an hour");
    const cropMode = stringArg(args, "crop") ?? "none";
    if (!["none", "center", "face"].includes(cropMode)) return fail(action, "media_clip crop must be none, center or face");
    const stem = stemOf(file.path.rel);
    const base = `${stem}.clip-${seconds(start)}-${seconds(end)}`;
    const out = output(action, "media_clip", stringArg(args, "output"), `${base}.mp4`);
    if (!out.ok) return out.record;
    const be = await backend();
    const notes: string[] = [];
    let crop: CropBox | undefined;
    if (cropMode !== "none") {
      const { probe: info, error } = await probeFile(file.path.rel);
      const video = info?.streams.find((s) => s.kind === "video" && s.width && s.height);
      if (!video?.width || !video.height) return fail(action, `media_clip failed: cannot read the frame size: ${error ?? "no video stream"}`);
      let cx = 0.5;
      if (cropMode === "face") {
        const found = await faceCentre(be, file.path.rel, start, end);
        if (found === undefined) notes.push("face tracking unavailable (MediaPipe or its model not installed, or no face found); cropped from the centre");
        else cx = found;
      }
      crop = portraitCrop(video.width, video.height, cx);
    }
    let captions: string | undefined;
    if (args.captions === true) {
      const transcript = readTranscript(stringArg(args, "transcript"), stem);
      if (!transcript.segments) return fail(action, `media_clip captions need a transcript: ${transcript.error ?? "none"}; run media_transcribe first`);
      const srt = output(action, "media_clip", undefined, `${base}.srt`);
      if (!srt.ok) return srt.record;
      fs.writeFileSync(srt.path.host, srtForWindow(transcript.segments, start, end));
      captions = srt.path.rel;
    }
    const result = await be.run("ffmpeg", clipArgs({ input: file.path.rel, start, end, output: out.path.rel, ...(crop ? { crop } : {}), ...(captions ? { captions } : {}) }));
    if (result.code !== 0 || !fs.existsSync(out.path.host)) return fail(action, `media_clip failed: ffmpeg exited ${result.code}: ${result.stderr.trim().split("\n").pop() ?? ""}`);
    const what = [`cut ${seconds(start)}-${seconds(end)} s`, crop ? `cropped to ${crop.width}x${crop.height} at x=${crop.x}` : "", captions ? `captions burned from ${captions}` : ""].filter(Boolean).join(", ");
    return record(MEDIA_ADAPTER_NAME, action, "completed", `${out.path.rel}: ${what}${notes.length ? `\nnote: ${notes.join("; ")}` : ""}`);
  }

  async function thumbnail(action: string, args: Record<string, unknown>): Promise<ToolCallRecord> {
    const file = input(action, "media_thumbnail", args);
    if (!file.ok) return file.record;
    const at = numberArg(args, "at") ?? 0;
    const width = numberArg(args, "width");
    if (at < 0 || (width !== undefined && (width < 16 || width > 8192))) return fail(action, "media_thumbnail needs at >= 0 and a width between 16 and 8192");
    const out = output(action, "media_thumbnail", stringArg(args, "output"), `${stemOf(file.path.rel)}.thumb-${seconds(at)}.png`);
    if (!out.ok) return out.record;
    const result = await (await backend()).run("ffmpeg", thumbnailArgs({ input: file.path.rel, at, output: out.path.rel, ...(width ? { width: Math.round(width) } : {}) }));
    if (result.code !== 0 || !fs.existsSync(out.path.host)) return fail(action, `media_thumbnail failed: ffmpeg exited ${result.code}: ${result.stderr.trim().split("\n").pop() ?? ""}`);
    return record(MEDIA_ADAPTER_NAME, action, "completed", `${out.path.rel}: frame at ${seconds(at)} s${width ? ` scaled to ${Math.round(width)} px wide` : ""}`);
  }

  /** Would this transcription leave the machine? Conservative and synchronous: yes unless whisper.cpp is at hand. */
  function hostedWouldRun(): boolean {
    if (!hostedAllowed || !options.gateway) return false;
    return !(findOnPath("whisper-cli", env) !== undefined && findWhisperModel(ctx.profileDir, whisperModel) !== undefined);
  }

  return {
    name: MEDIA_ADAPTER_NAME,
    scopes: [...MEDIA_SCOPES],
    availability: "real",
    instructions: renderToolInstructions(MEDIA_TOOL_SCHEMAS),
    routingText: MEDIA_ROUTING_TEXT,
    healthCheck: async () => "connected",
    estimateCost: () => 0,
    requiresApproval(action) {
      const parsed = parseAction(action, MEDIA_SPECS);
      return !parsed.error && parsed.tool === "media_transcribe" && hostedWouldRun();
    },
    /** What leaves the machine when the hosted path is approved: named for the human, never sent before the yes. */
    preview(action) {
      const parsed = parseAction(action, MEDIA_SPECS);
      if (parsed.error || parsed.tool !== "media_transcribe" || !hostedWouldRun()) return undefined;
      const provider = options.gateway?.resolveRoute("executor").providers[0] ?? "the configured provider";
      return `send the audio track of ${stringArg(parsed.args, "input") ?? "(no input)"} to ${String(provider)} for transcription; the file's audio leaves this machine`;
    },
    async dryRun(action) {
      return record(MEDIA_ADAPTER_NAME, action, "needs_approval", "media_transcribe would send this file's audio to the configured model provider (media.hosted_transcription is on and no local whisper engine was found). Approve to let the audio leave this machine.");
    },
    async execute(action) {
      const parsed = parseAction(action, MEDIA_SPECS);
      if (parsed.error) return fail(action, parsed.error);
      try {
        switch (parsed.tool) {
          case "media_probe": return await probe(action, parsed.args);
          case "media_transcribe": return await transcribe(action, parsed.args);
          case "media_scenes": return await scenes(action, parsed.args);
          case "media_clip": return await clip(action, parsed.args);
          case "media_thumbnail": return await thumbnail(action, parsed.args);
          default: return fail(action, `unknown media tool ${parsed.tool}`);
        }
      } catch (error) {
        return fail(action, `${parsed.tool} failed: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
      }
    },
    cleanup: async () => undefined,
  };
}
