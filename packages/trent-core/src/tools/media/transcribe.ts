/**
 * Transcription, the one path `media_transcribe` and `voice/index.ts` share.
 *
 * Engines, tried in this order and named in the result:
 *   whisper.cpp     `whisper-cli` on the backend plus a ggml model file (config `media.whisper_model`,
 *                   else `<profile>/models/ggml-*.bin`, else the model the media image bundles);
 *   faster-whisper  `python3` with the `faster_whisper` module (the model is downloaded by that
 *                   library on first use into its own cache);
 *   hosted          the configured model provider through the gateway. This sends the audio off
 *                   the machine, which is egress of private content: it runs only when
 *                   `media.hosted_transcription` is true, the adapter asks for approval before
 *                   it, and the doctor names it. Cost goes on the spend ledger as `surface: tool`.
 *
 * With none available the call fails and says what to install and where the opt-in lives. It
 * never returns transcript-shaped text that no engine produced (AGENTS.md invariant 2).
 */
import fs from "node:fs";
import path from "node:path";
import { currentSpendLedger } from "../../governance/spend-ledger.js";
import { currentToolCallContext } from "../../governance/tool-call-context.js";
import type { GatewayMessage, ModelGateway } from "../../model-gateway/types.js";
import type { MediaBackend } from "./backend.js";
import { audioExtractArgs, fasterWhisperArgs, parseFasterWhisperJson, parseWhisperJson, pythonModuleProbeArgs, whisperArgs, type TranscriptSegment } from "./commands.js";
import { MEDIA_OUTPUT_DIR, type ResolvedPath } from "./paths.js";

/** The model `scripts/sandbox/media/Dockerfile` bundles. */
export const MEDIA_IMAGE_MODEL = "/opt/trent/models/ggml-base.en.bin";
/** faster-whisper's model size when nothing else is configured; small enough to run on a laptop CPU. */
export const FASTER_WHISPER_MODEL = "base";
/** Inline audio the hosted path accepts; above this the provider needs a file upload the wrapper does not do. */
export const HOSTED_MAX_BYTES = 20 * 1024 * 1024;
/** The gateway's answer is a paragraph per minute of audio; this bounds a long file's transcript. */
const HOSTED_MAX_TOKENS = 8192;

export type TranscriptEngine = "whisper.cpp" | "faster-whisper" | `hosted:${string}`;

export interface Transcript {
  readonly engine: TranscriptEngine;
  readonly language?: string;
  readonly segments: readonly TranscriptSegment[];
}

export type TranscriptionGateway = Pick<ModelGateway, "complete" | "resolveRoute">;

export interface TranscribeInput {
  readonly backend: MediaBackend;
  readonly workspace: string;
  readonly profileDir: string;
  /** The media file, already resolved under the workspace. */
  readonly input: ResolvedPath;
  /** `media.whisper_model`; empty means search. */
  readonly whisperModel: string;
  readonly language?: string;
  /** `media.hosted_transcription`. */
  readonly hostedAllowed: boolean;
  readonly gateway?: TranscriptionGateway;
}

export type TranscribeResult = { ok: true; transcript: Transcript } | { ok: false; reason: string };

/** The whisper.cpp model this install would use, as a host path, or undefined. */
export function findWhisperModel(profileDir: string, configured: string): string | undefined {
  if (configured.trim() !== "") return fs.existsSync(configured) ? path.resolve(configured) : undefined;
  const dir = path.join(profileDir, "models");
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((name) => /^ggml-.*\.bin$/.test(name));
  } catch {
    return undefined;
  }
  const sized = names.map((name) => ({ name, size: fs.statSync(path.join(dir, name)).size })).sort((a, b) => a.size - b.size);
  return sized[0] ? path.join(dir, sized[0].name) : undefined;
}

/** Which engine a call would take, before anything runs: the adapter's approval question. */
export type EnginePlan = { engine: "whisper.cpp"; model: string } | { engine: "faster-whisper" } | { engine: "hosted" } | { engine: "none"; reason: string };

export async function planEngine(input: Pick<TranscribeInput, "backend" | "profileDir" | "whisperModel" | "hostedAllowed" | "gateway">): Promise<EnginePlan> {
  const installed = await input.backend.installed();
  if (installed["whisper-cli"]) {
    const hostModel = findWhisperModel(input.profileDir, input.whisperModel);
    if (hostModel !== undefined) return { engine: "whisper.cpp", model: hostModel };
    if (input.backend.kind === "docker") return { engine: "whisper.cpp", model: MEDIA_IMAGE_MODEL };
  }
  if (installed.python3 && input.backend.kind === "host") {
    const probe = await input.backend.run("python3", pythonModuleProbeArgs("faster_whisper"), { timeoutMs: 30_000 });
    if (probe.code === 0) return { engine: "faster-whisper" };
  }
  if (input.hostedAllowed && input.gateway) return { engine: "hosted" };
  const missing = installed["whisper-cli"] ? "whisper-cli is installed but no ggml model file was found" : "no local whisper engine is installed";
  return {
    engine: "none",
    reason:
      `${missing}. Install whisper.cpp (brew install whisper-cpp; then put a ggml model such as ggml-base.en.bin in ${path.join(input.profileDir, "models")} ` +
      "or set media.whisper_model), or pip install faster-whisper, or build the media image (docs/media.md). " +
      "Hosted transcription through the configured provider sends the audio off this machine and is off until media.hosted_transcription is true.",
  };
}

async function extractWav(input: TranscribeInput): Promise<{ ok: true; wav: ResolvedPath } | { ok: false; reason: string }> {
  const dir = path.join(input.workspace, MEDIA_OUTPUT_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const name = `${path.posix.basename(input.input.rel).replace(/\.[^.]*$/, "")}.${process.pid}.16k.wav`;
  const wav = { host: path.join(dir, name), rel: `${MEDIA_OUTPUT_DIR}/${name}` };
  const result = await input.backend.run("ffmpeg", audioExtractArgs(input.input.rel, wav.rel));
  if (result.code !== 0) return { ok: false, reason: `ffmpeg could not extract the audio (exit ${result.code}): ${result.stderr.trim().split("\n").pop() ?? ""}` };
  return { ok: true, wav };
}

async function runWhisperCpp(input: TranscribeInput, wav: ResolvedPath, hostModel: string): Promise<TranscribeResult> {
  const ref = hostModel === MEDIA_IMAGE_MODEL ? { arg: MEDIA_IMAGE_MODEL, mounts: [] } : input.backend.modelRef(hostModel);
  const outBase = wav.rel.replace(/\.wav$/, "");
  const result = await input.backend.run("whisper-cli", whisperArgs({ model: ref.arg, audio: wav.rel, outBase, ...(input.language ? { language: input.language } : {}) }), { readOnlyMounts: ref.mounts });
  const jsonPath = path.join(input.workspace, `${outBase}.json`);
  let segments: TranscriptSegment[] | undefined;
  try {
    segments = parseWhisperJson(fs.readFileSync(jsonPath, "utf8"));
  } catch {
    segments = undefined;
  } finally {
    fs.rmSync(jsonPath, { force: true });
  }
  if (result.code !== 0 || segments === undefined) {
    return { ok: false, reason: `whisper-cli did not produce a transcript (exit ${result.code}): ${result.stderr.trim().split("\n").pop() ?? ""}` };
  }
  return { ok: true, transcript: { engine: "whisper.cpp", segments } };
}

async function runFasterWhisper(input: TranscribeInput, wav: ResolvedPath): Promise<TranscribeResult> {
  const result = await input.backend.run("python3", fasterWhisperArgs({ audio: wav.rel, modelSize: FASTER_WHISPER_MODEL, ...(input.language ? { language: input.language } : {}) }));
  const parsed = result.code === 0 ? parseFasterWhisperJson(result.stdout) : undefined;
  if (parsed === undefined) return { ok: false, reason: `faster-whisper did not produce a transcript (exit ${result.code}): ${result.stderr.trim().split("\n").pop() ?? ""}` };
  return { ok: true, transcript: { engine: "faster-whisper", ...(parsed.language ? { language: parsed.language } : {}), segments: parsed.segments } };
}

const HOSTED_PROMPT =
  "Transcribe the attached audio. Answer with a JSON array only, no prose: each element {\"start\": seconds, \"end\": seconds, \"text\": \"...\"}, " +
  "one element per spoken sentence, in order, with start and end as numbers of seconds from the beginning of the audio.";

function parseHosted(text: string): TranscriptSegment[] | undefined {
  const body = text.replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
  try {
    const parsed: unknown = JSON.parse(body);
    if (!Array.isArray(parsed)) return undefined;
    return parsed
      .map((row) => (row && typeof row === "object" ? (row as { start?: unknown; end?: unknown; text?: unknown }) : {}))
      .map((row) => ({ start: Number(row.start), end: Number(row.end), text: String(row.text ?? "").trim() }))
      .filter((row) => Number.isFinite(row.start) && Number.isFinite(row.end) && row.text !== "");
  } catch {
    return undefined;
  }
}

/** The audio in the user message as an OpenAI-compatible `input_audio` part, on the gateway's string-typed content. */
export function buildHostedMessages(wav: Buffer): GatewayMessage[] {
  const parts: unknown[] = [
    { type: "text", text: HOSTED_PROMPT },
    { type: "input_audio", input_audio: { data: wav.toString("base64"), format: "wav" } },
  ];
  return [
    { role: "system", content: "You are a precise transcription service. Output JSON only." },
    { role: "user", content: parts as unknown as string },
  ];
}

async function runHosted(input: TranscribeInput, wav: ResolvedPath): Promise<TranscribeResult> {
  if (!input.gateway) return { ok: false, reason: "hosted transcription needs a model gateway and none is bound to this seat" };
  const bytes = fs.readFileSync(wav.host);
  if (bytes.length > HOSTED_MAX_BYTES) return { ok: false, reason: `the extracted audio is ${bytes.length} bytes; hosted transcription accepts up to ${HOSTED_MAX_BYTES} inline` };
  const provider = input.gateway.resolveRoute("executor").providers[0] ?? "unknown";
  const completion = await input.gateway.complete({ messages: buildHostedMessages(bytes), role: "executor", maxTokens: HOSTED_MAX_TOKENS, temperature: 0 });
  // G5: external spend is a ledger row with the provider, so budget.daily_cap sees it.
  currentSpendLedger()?.append({
    surface: "tool",
    run_id: currentToolCallContext()?.runId ?? "none",
    model: completion.model,
    provider: completion.provider,
    cents: Math.trunc(completion.costCents),
    tokens: completion.inputTokens + completion.outputTokens,
  });
  const segments = parseHosted(completion.text);
  if (segments === undefined) return { ok: false, reason: `the hosted provider (${completion.provider}) did not answer with a JSON transcript` };
  return { ok: true, transcript: { engine: `hosted:${String(provider)}`, segments } };
}

/** Extracts the audio, runs the first available engine, and removes the intermediate wav. */
export async function transcribeMedia(input: TranscribeInput): Promise<TranscribeResult> {
  const plan = await planEngine(input);
  if (plan.engine === "none") return { ok: false, reason: plan.reason };
  const extracted = await extractWav(input);
  if (!extracted.ok) return extracted;
  try {
    if (plan.engine === "whisper.cpp") return await runWhisperCpp(input, extracted.wav, plan.model);
    if (plan.engine === "faster-whisper") return await runFasterWhisper(input, extracted.wav);
    return await runHosted(input, extracted.wav);
  } finally {
    fs.rmSync(extracted.wav.host, { force: true });
  }
}
