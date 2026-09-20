/**
 * The argument arrays the media tools run, and the parsers for what the binaries answer. Pure:
 * every function here takes validated values (a workspace-relative path, a number the adapter
 * bounded) and returns the exact argv, so a test can assert the array a fake binary received is
 * the array this module builds. No function here spawns anything or composes a shell string;
 * the only strings assembled are ffmpeg filter graphs from numbers this module formats itself.
 */

/** One transcript segment. Seconds, not milliseconds; the whisper.cpp offsets are converted. */
export interface TranscriptSegment {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

export interface MediaStream {
  readonly kind: string;
  readonly codec: string;
  readonly width?: number;
  readonly height?: number;
  readonly fps?: number;
  readonly sampleRate?: number;
  readonly channels?: number;
}

export interface MediaProbe {
  readonly durationSeconds: number | undefined;
  readonly container: string;
  readonly sizeBytes: number | undefined;
  readonly streams: readonly MediaStream[];
}

/** `ffprobe`: the format and the streams as JSON. */
export function probeArgs(input: string): string[] {
  return ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", input];
}

/** `ffmpeg`: the 16 kHz mono PCM wav every whisper engine wants. */
export function audioExtractArgs(input: string, wav: string): string[] {
  return ["-nostdin", "-y", "-v", "error", "-i", input, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wav];
}

/** `whisper-cli` (whisper.cpp): JSON output beside `outBase`, no progress prints. */
export function whisperArgs(input: { model: string; audio: string; outBase: string; language?: string }): string[] {
  const args = ["-m", input.model, "-f", input.audio, "-oj", "-of", input.outBase, "-np"];
  if (input.language) args.push("-l", input.language);
  return args;
}

/**
 * faster-whisper, run as `python3 -c <this> <wav> <model-size> [language]`. The script is a
 * constant; the audio path and the model size travel as argv, never inside the source.
 */
export const FASTER_WHISPER_SCRIPT = [
  "import json, sys",
  "from faster_whisper import WhisperModel",
  "audio, size = sys.argv[1], sys.argv[2]",
  "language = sys.argv[3] if len(sys.argv) > 3 else None",
  'model = WhisperModel(size, device="cpu", compute_type="int8")',
  "segments, info = model.transcribe(audio, language=language, vad_filter=True)",
  'print(json.dumps({"language": info.language, "segments": [{"start": s.start, "end": s.end, "text": s.text} for s in segments]}))',
].join("\n");

export function fasterWhisperArgs(input: { audio: string; modelSize: string; language?: string }): string[] {
  const args = ["-c", FASTER_WHISPER_SCRIPT, input.audio, input.modelSize];
  if (input.language) args.push(input.language);
  return args;
}

/** `python3 -c <probe>`: does this interpreter have a module? Exit 0 means yes. */
export function pythonModuleProbeArgs(moduleName: string): string[] {
  return ["-c", `import importlib.util, sys; sys.exit(0 if importlib.util.find_spec(${JSON.stringify(moduleName)}) else 1)`];
}

/** PySceneDetect: adaptive detection, the scene list as CSV without the cut-list preamble. */
export function sceneDetectArgs(input: { input: string; outDir: string; csvName: string }): string[] {
  return ["-i", input.input, "-q", "detect-adaptive", "list-scenes", "-o", input.outDir, "-f", input.csvName, "-s"];
}

/** ffmpeg's scene filter: the fallback when scenedetect is not installed. `threshold` is 0..1. */
export function sceneFilterArgs(input: string, threshold: number): string[] {
  const t = Math.min(1, Math.max(0, threshold)).toFixed(2);
  return ["-nostdin", "-v", "info", "-i", input, "-vf", `select='gt(scene,${t})',showinfo`, "-an", "-f", "null", "-"];
}

export interface CropBox {
  readonly width: number;
  readonly height: number;
  readonly x: number;
  /** Defaults to 0: a 9:16 crop keeps the full height. */
  readonly y?: number;
}

export interface ClipArgsInput {
  readonly input: string;
  readonly start: number;
  readonly end: number;
  readonly output: string;
  readonly crop?: CropBox;
  /** Workspace-relative path of an .srt file to burn in. Written by the tool, never named by the model. */
  readonly captions?: string;
}

/** Seconds as ffmpeg reads them, at millisecond precision. */
export function seconds(value: number): string {
  return value.toFixed(3).replace(/\.?0+$/, "") || "0";
}

/** `ffmpeg`: a cut, an optional crop, optional burned captions, an MP4 a phone will play. */
export function clipArgs(input: ClipArgsInput): string[] {
  const filters: string[] = [];
  if (input.crop) filters.push(`crop=${Math.round(input.crop.width)}:${Math.round(input.crop.height)}:${Math.round(input.crop.x)}:${Math.round(input.crop.y ?? 0)}`);
  if (input.captions) filters.push(`subtitles=${input.captions}`);
  const args = ["-nostdin", "-y", "-v", "error", "-ss", seconds(input.start), "-to", seconds(input.end), "-i", input.input];
  if (filters.length > 0) args.push("-vf", filters.join(","));
  args.push("-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart", input.output);
  return args;
}

/** `ffmpeg`: one frame at `at` seconds, optionally scaled to `width` (height follows, even). */
export function thumbnailArgs(input: { input: string; at: number; output: string; width?: number }): string[] {
  const args = ["-nostdin", "-y", "-v", "error", "-ss", seconds(input.at), "-i", input.input, "-frames:v", "1"];
  if (input.width) args.push("-vf", `scale=${Math.round(input.width)}:-2`);
  args.push(input.output);
  return args;
}

/**
 * MediaPipe face tracking, run as `python3 -c <this> <input> <start> <end>`: samples frames in
 * the window, detects faces, prints the mean face-centre x as a fraction of the frame width.
 */
export const FACE_TRACK_SCRIPT = [
  "import json, sys",
  "import cv2",
  "import mediapipe as mp",
  "from mediapipe.tasks import python as mp_python",
  "from mediapipe.tasks.python import vision",
  "path, start, end = sys.argv[1], float(sys.argv[2]), float(sys.argv[3])",
  "cap = cv2.VideoCapture(path)",
  "fps = cap.get(cv2.CAP_PROP_FPS) or 30.0",
  "width = cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 1.0",
  "opts = vision.FaceDetectorOptions(base_options=mp_python.BaseOptions(model_asset_path=sys.argv[4]), running_mode=vision.RunningMode.IMAGE)",
  "detector = vision.FaceDetector.create_from_options(opts)",
  "centres = []",
  "t = start",
  "while t <= end:",
  "    cap.set(cv2.CAP_PROP_POS_MSEC, t * 1000.0)",
  "    ok, frame = cap.read()",
  "    if not ok: break",
  "    image = mp.Image(image_format=mp.ImageFormat.SRGB, data=cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))",
  "    result = detector.detect(image)",
  "    if result.detections:",
  "        box = result.detections[0].bounding_box",
  "        centres.append((box.origin_x + box.width / 2.0) / width)",
  "    t += 0.5",
  'print(json.dumps({"faces": len(centres), "cx": (sum(centres) / len(centres)) if centres else None}))',
].join("\n");

export function faceTrackArgs(input: { input: string; start: number; end: number; modelAsset: string }): string[] {
  return ["-c", FACE_TRACK_SCRIPT, input.input, seconds(input.start), seconds(input.end), input.modelAsset];
}

/** A 9:16 window over a `width x height` frame, centred on `cx` (a fraction of the width). Even width: libx264 needs it. */
export function portraitCrop(width: number, height: number, cx: number): CropBox {
  const wanted = Math.min(width, Math.round((height * 9) / 16));
  const cropWidth = wanted % 2 === 0 ? wanted : wanted - 1;
  const x = Math.round(cx * width - cropWidth / 2);
  return { width: cropWidth, height, x: Math.max(0, Math.min(width - cropWidth, x)), y: 0 };
}

// --- Parsers -----------------------------------------------------------------------------------

function num(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(n) ? n : undefined;
}

function fpsOf(rate: unknown): number | undefined {
  if (typeof rate !== "string") return undefined;
  const [n, d] = rate.split("/").map(Number);
  if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0) return undefined;
  return Math.round((n / d) * 100) / 100;
}

export function parseProbe(stdout: string): MediaProbe | undefined {
  let parsed: { format?: Record<string, unknown>; streams?: Array<Record<string, unknown>> };
  try {
    parsed = JSON.parse(stdout) as typeof parsed;
  } catch {
    return undefined;
  }
  const format = parsed.format ?? {};
  const streams = (parsed.streams ?? []).map((s) => ({
    kind: String(s.codec_type ?? "unknown"),
    codec: String(s.codec_name ?? "unknown"),
    ...(num(s.width) !== undefined ? { width: num(s.width) } : {}),
    ...(num(s.height) !== undefined ? { height: num(s.height) } : {}),
    ...(fpsOf(s.r_frame_rate) !== undefined ? { fps: fpsOf(s.r_frame_rate) } : {}),
    ...(num(s.sample_rate) !== undefined ? { sampleRate: num(s.sample_rate) } : {}),
    ...(num(s.channels) !== undefined ? { channels: num(s.channels) } : {}),
  }));
  return { durationSeconds: num(format.duration), container: String(format.format_name ?? "unknown"), sizeBytes: num(format.size), streams };
}

/** whisper.cpp `-oj`: `transcription[].offsets` are milliseconds. */
export function parseWhisperJson(text: string): TranscriptSegment[] | undefined {
  let parsed: { transcription?: Array<{ offsets?: { from?: number; to?: number }; text?: string }> };
  try {
    parsed = JSON.parse(text) as typeof parsed;
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed.transcription)) return undefined;
  return parsed.transcription
    .map((row) => ({ start: (num(row.offsets?.from) ?? 0) / 1000, end: (num(row.offsets?.to) ?? 0) / 1000, text: String(row.text ?? "").trim() }))
    .filter((row) => row.text !== "");
}

/** The faster-whisper script's one JSON line. */
export function parseFasterWhisperJson(text: string): { language?: string; segments: TranscriptSegment[] } | undefined {
  const line = text.trim().split("\n").filter((l) => l.trim() !== "").pop() ?? "";
  let parsed: { language?: string; segments?: Array<{ start?: number; end?: number; text?: string }> };
  try {
    parsed = JSON.parse(line) as typeof parsed;
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed.segments)) return undefined;
  return {
    ...(parsed.language ? { language: parsed.language } : {}),
    segments: parsed.segments.map((s) => ({ start: num(s.start) ?? 0, end: num(s.end) ?? 0, text: String(s.text ?? "").trim() })).filter((s) => s.text !== ""),
  };
}

/** `showinfo` on stderr: every `pts_time:<seconds>` is a frame the scene filter selected. */
export function parseSceneFilterTimes(stderr: string): number[] {
  const times: number[] = [];
  for (const match of stderr.matchAll(/pts_time:\s*([0-9.]+)/g)) {
    const t = Number(match[1]);
    if (Number.isFinite(t)) times.push(t);
  }
  return times;
}

/** PySceneDetect's scene CSV with `-s`: a header row, then one row per scene. */
export function parseSceneCsv(csv: string): Array<{ start: number; end: number }> {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim() !== "");
  const header = lines.findIndex((l) => l.startsWith("Scene Number"));
  if (header === -1) return [];
  const columns = lines[header]!.split(",");
  const startIndex = columns.indexOf("Start Time (seconds)");
  const endIndex = columns.indexOf("End Time (seconds)");
  if (startIndex === -1 || endIndex === -1) return [];
  const scenes: Array<{ start: number; end: number }> = [];
  for (const line of lines.slice(header + 1)) {
    const cells = line.split(",");
    const start = Number(cells[startIndex]);
    const end = Number(cells[endIndex]);
    if (Number.isFinite(start) && Number.isFinite(end)) scenes.push({ start, end });
  }
  return scenes;
}

// --- Captions ----------------------------------------------------------------------------------

function srtTime(value: number): string {
  const total = Math.max(0, value);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = Math.floor(total % 60);
  const ms = Math.round((total - Math.floor(total)) * 1000);
  const pad = (n: number, w: number): string => String(n).padStart(w, "0");
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)},${pad(ms, 3)}`;
}

/** The segments that overlap `[start, end]`, re-based to the clip's own clock, as SubRip text. */
export function srtForWindow(segments: readonly TranscriptSegment[], start: number, end: number): string {
  const rows: string[] = [];
  let index = 1;
  for (const segment of segments) {
    if (segment.end <= start || segment.start >= end) continue;
    const from = Math.max(0, segment.start - start);
    const to = Math.min(end - start, segment.end - start);
    if (to <= from) continue;
    rows.push(`${index}\n${srtTime(from)} --> ${srtTime(to)}\n${segment.text}\n`);
    index += 1;
  }
  return rows.join("\n");
}

/** `[0.00 -> 1.50] text` lines: what the model reads back. */
export function renderSegments(segments: readonly TranscriptSegment[]): string {
  return segments.map((s) => `[${s.start.toFixed(2)} -> ${s.end.toFixed(2)}] ${s.text}`).join("\n");
}
