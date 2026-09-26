/**
 * [L0-4] Local Model: is the local runtime this profile sends every model call to actually usable?
 * (audit G8 and G17; local-models D1-D3.)
 *
 * The credentials check used to `skip` a keyless provider, so `trent doctor` exited 0 with Ollama
 * down and the model not pulled. This check runs only when the provider is local (the `ollama` and
 * `lmstudio` aliases, or any provider whose base URL is a loopback host, which is how a llama.cpp
 * `llama-server` is reached) and reports, from the runtime itself:
 *   - the runtime and its version, at the base URL the runtime would use;
 *   - every configured model present, with the exact `ollama pull <tag>` when one is not;
 *   - the effective context window (the loaded model's, not the training maximum), warned under
 *     32768: seat prompts measured about 6.2k tokens plus an 8192-token reply budget (audit, G17);
 *   - the server's slots or parallel predictions when it exposes them;
 *   - a five-case tool-call smoke test through the wrapper's own model gateway, scored N/5;
 *   - the time to first token at a 4K-token prompt, warned over 60 s.
 * Every request goes through the doctor's fetch seam. An Ollama cloud model is never sent a prompt.
 */
import type { TrentConfig } from "../../config/schema.js";
import type { ReasoningEffort } from "../../model-gateway/call-policy.js";
import { DEFAULT_PROBE_TIMEOUT_MS } from "../probe.js";
import { doctorEnv, providerEndpoint, type ProviderEndpoint } from "../endpoint.js";
import type { CheckResult, DoctorCheck, DoctorContext } from "../types.js";
import {
  RUNTIME_LABELS,
  detectRuntime,
  findServedModel,
  listServedModels,
  readLmStudioLoaded,
  readOllamaLoadedContext,
  readOllamaShow,
  type LocalRuntimeKind,
  type OllamaShow,
  type ProbeSeam,
  type RuntimeIdentity,
} from "./local-runtime.js";
import { SMOKE_CASES, firstTokenPrompt, runSmoke, type SmokeReport } from "./local-smoke.js";
import { measureFirstToken, type FirstTokenReading } from "./local-stream.js";

export const LOCAL_MODEL_CATEGORY = "Local Model";
export const CONTEXT_FLOOR_TOKENS = 32_768;
export const TTFT_PROMPT_TOKENS = 4096;
export const TTFT_WARN_MS = 60_000;
export const SMOKE_CASE_TIMEOUT_MS = 60_000;
export const SMOKE_MAX_TOKENS = 2048;
/** Head room for the reachability, model-list and context probes around the smoke and first token. */
const PROBE_ALLOWANCE_MS = 60_000;

export interface LocalModelCheckOptions {
  readonly smokeCaseTimeoutMs?: number;
  readonly ttftWarnMs?: number;
  readonly smokeMaxTokens?: number;
}

type Level = "fail" | "warn";
interface Finding { level: Level; hint: string }

function result(partial: Omit<CheckResult, "category" | "name">): CheckResult {
  return { category: LOCAL_MODEL_CATEGORY, name: LOCAL_MODEL_CATEGORY, ...partial };
}

function seconds(ms: number): string {
  return Number((ms / 1000).toFixed(2)).toString();
}

function unreachableHint(endpoint: ProviderEndpoint): string {
  const move = endpoint.baseUrlEnv ? `, or point ${endpoint.baseUrlEnv} at the server that runs it` : "";
  if (endpoint.alias?.alias === "ollama") return `Start Ollama (\`ollama serve\`, or open the Ollama app)${move}.`;
  if (endpoint.alias?.alias === "lmstudio") return `Start LM Studio's server (\`lms server start\`)${move}; a llama.cpp \`llama-server\` works there too.`;
  return `Start the local model server${move}.`;
}

function missingHint(kind: LocalRuntimeKind, missing: readonly string[]): string {
  const choose = "or set one it serves with `trent config set model <id>`.";
  if (kind === "ollama") return `${missing.map((m) => `\`ollama pull ${m}\``).join(" and ")}, ${choose}`;
  if (kind === "lmstudio") return `${missing.map((m) => `\`lms get ${m}\` then \`lms load ${m}\``).join(" and ")}, ${choose}`;
  return `Start the server with ${missing.join(" and ")}, ${choose}`;
}

function contextHint(kind: LocalRuntimeKind): string {
  const floor = CONTEXT_FLOOR_TOKENS;
  switch (kind) {
    case "ollama":
      return `Raise the window to at least ${floor}: set OLLAMA_CONTEXT_LENGTH=${floor} in the Ollama server's environment and restart it, or build the model from a Modelfile with \`PARAMETER num_ctx ${floor}\` (https://docs.ollama.com/context-length).`;
    case "llama.cpp":
      return `Restart llama-server with \`-c\` large enough that every slot gets at least ${floor} tokens; the context is divided among the \`-np\` slots (https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md).`;
    case "lmstudio":
      return `Reload the model in LM Studio with a context length of at least ${floor}; it loads at 8192 by default since 0.4.16 (https://lmstudio.ai/changelog/lmstudio/lmstudio-v0.4.16).`;
    default:
      return `This server does not report its context window; make sure it is at least ${floor} tokens.`;
  }
}

interface ContextReading { tokens?: number; source: string; trainedMax?: number }

async function readContext(identity: RuntimeIdentity, baseUrl: string, model: string, show: OllamaShow, seam: ProbeSeam): Promise<{ context: ContextReading; slots?: number }> {
  if (identity.kind === "ollama") {
    const trained = show.trainedContext === undefined ? {} : { trainedMax: show.trainedContext };
    const loaded = await readOllamaLoadedContext(baseUrl, model, seam);
    if (loaded !== undefined) return { context: { tokens: loaded, source: "the loaded model, /api/ps", ...trained } };
    if (show.numCtx !== undefined) return { context: { tokens: show.numCtx, source: "Modelfile num_ctx", ...trained } };
    return { context: { source: "not loaded, so the server default applies (OLLAMA_CONTEXT_LENGTH)", ...trained } };
  }
  if (identity.kind === "llama.cpp") {
    return { context: identity.nCtx === undefined ? { source: "/props has no n_ctx" } : { tokens: identity.nCtx, source: "/props n_ctx" }, ...(identity.slots === undefined ? {} : { slots: identity.slots }) };
  }
  if (identity.kind === "lmstudio") {
    const loaded = await readLmStudioLoaded(baseUrl, model, seam);
    return {
      context: loaded.contextLength === undefined ? { source: "no loaded instance reported" } : { tokens: loaded.contextLength, source: "loaded instance, /api/v1/models" },
      ...(loaded.parallel === undefined ? {} : { slots: loaded.parallel }),
    };
  }
  return { context: { source: "not reported by this server" } };
}

function slotsPhrase(kind: LocalRuntimeKind, slots: number | undefined): string | undefined {
  if (slots !== undefined) return kind === "lmstudio" ? `${slots} parallel predictions` : `${slots} slots`;
  return kind === "ollama" ? "parallel slots not exposed (OLLAMA_NUM_PARALLEL, default 1)" : undefined;
}

function smokePhrase(smoke: SmokeReport): string {
  const failed = smoke.cases.filter((c) => !c.pass);
  return `tool-call smoke ${smoke.score}/${smoke.total}${failed.length === 0 ? "" : ` (failed: ${failed.map((c) => `${c.id}: ${c.reason}`).join("; ")})`}`;
}

function ttftPhrase(ttft: FirstTokenReading, warnMs: number): string {
  if (ttft.timedOut) return `no first token within ${seconds(warnMs)} s at a ${TTFT_PROMPT_TOKENS}-token prompt`;
  if (ttft.ms === undefined) return `first token not measured: ${ttft.error ?? "no answer"}`;
  return `first token after ${(ttft.ms / 1000).toFixed(1)} s at ${ttft.promptTokens ?? `about ${TTFT_PROMPT_TOKENS}`} prompt tokens`;
}

function configuredModels(config: TrentConfig, fallback: string): { primary: string; all: string[] } {
  const primary = config.model?.trim() || fallback;
  const tiers = [config.models?.fast, config.models?.executor, config.models?.planner, config.models?.judge].filter((m): m is string => typeof m === "string" && m.trim() !== "");
  return { primary, all: [...new Set([primary, ...tiers.map((m) => m.trim())])] };
}

async function run(ctx: DoctorContext, limits: Required<LocalModelCheckOptions>): Promise<CheckResult> {
  const config = ctx.configManager.loadConfig();
  const provider = config.provider;
  const endpoint = providerEndpoint(provider, doctorEnv(ctx));
  if (endpoint === undefined || !endpoint.local) {
    return result({
      status: "skip",
      message: `Provider "${provider}" is hosted${endpoint ? ` (${endpoint.host})` : ""}; there is no local model runtime to check.`,
      details: { provider, local: false },
    });
  }

  const seam: ProbeSeam = { ...(ctx.fetchImpl === undefined ? {} : { fetchImpl: ctx.fetchImpl }), timeoutMs: ctx.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS };
  const { primary, all } = configuredModels(config, endpoint.alias?.defaultModel ?? "");
  const base = { provider, baseUrl: endpoint.url, model: primary };

  const detection = await detectRuntime(endpoint.url, seam);
  if (!detection.ok) {
    const why = detection.why === "timeout" ? `no answer within ${seam.timeoutMs}ms` : detection.why === "network" ? "no connection" : `a server answered, but not as Ollama, llama.cpp or an OpenAI-compatible server (GET /v1/models: HTTP ${detection.status ?? "none"})`;
    return result({
      status: "fail",
      message: `No local model runtime answered at ${endpoint.url} (${why}), and provider "${provider}" sends every model call there.`,
      fixHint: unreachableHint(endpoint),
      details: { ...base, reachable: false, reason: detection.why },
    });
  }

  const identity = detection.identity;
  const label = `${RUNTIME_LABELS[identity.kind]}${identity.version ? ` ${identity.version}` : ""}`;
  const runtime = { ...base, runtime: identity.kind, ...(identity.version ? { version: identity.version } : {}) };
  const served = await listServedModels(identity, endpoint.url, seam);
  if (typeof served === "string") {
    return result({ status: "fail", message: `${label} at ${endpoint.url} answered, but its model list could not be read: ${served}.`, fixHint: unreachableHint(endpoint), details: runtime });
  }
  const missing = all.filter((model) => findServedModel(model, served, identity.kind) === undefined);
  if (missing.length > 0) {
    const verb = identity.kind === "ollama" ? "pulled" : "served";
    const has = served.slice(0, 6).map((m) => m.id).join(", ") || "nothing";
    return result({
      status: "fail",
      message: `${label} at ${endpoint.url} is up, but ${missing.map((m) => `"${m}"`).join(" and ")} ${missing.length === 1 ? "is" : "are"} not ${verb} (it has: ${has}).`,
      fixHint: missingHint(identity.kind, missing),
      details: { ...runtime, missing, served: served.map((m) => m.id) },
    });
  }

  if (findServedModel(primary, served, identity.kind)?.cloud === true) {
    return result({
      status: "warn",
      message: `${label} at ${endpoint.url} lists ${primary} as an Ollama cloud model: its prompts would leave this machine, so the doctor sent it none and did not smoke-test it.`,
      fixHint: "For a local stack, `ollama pull <tag>` a local model and `trent config set model <tag>`.",
      details: { ...runtime, cloud: true },
    });
  }

  const show = identity.kind === "ollama" ? await readOllamaShow(endpoint.url, primary, seam) : {};
  const route = { baseUrl: endpoint.url, ...(ctx.fetchImpl === undefined ? {} : { fetchImpl: ctx.fetchImpl }) };
  const effort: ReasoningEffort | undefined = config.models?.reasoning_effort;
  const smoke = await runSmoke({
    route,
    provider: endpoint.alias?.provider ?? "openai",
    model: primary,
    caseTimeoutMs: limits.smokeCaseTimeoutMs,
    maxTokens: limits.smokeMaxTokens,
    ...(effort === undefined ? {} : { reasoningEffort: effort }),
  });
  const ttft = await measureFirstToken(route, {
    model: primary,
    messages: [{ role: "system", content: "Answer in one word." }, { role: "user", content: firstTokenPrompt(TTFT_PROMPT_TOKENS) }],
    temperature: 0,
    maxTokens: 16,
    ...(effort === undefined ? {} : { reasoningEffort: effort }),
  }, limits.ttftWarnMs);
  // Read after the smoke and the first-token probe, which loaded the model: the window in use.
  const { context, slots } = await readContext(identity, endpoint.url, primary, show, seam);

  const findings: Finding[] = [];
  if (context.tokens === undefined || context.tokens < CONTEXT_FLOOR_TOKENS) findings.push({ level: "warn", hint: contextHint(identity.kind) });
  if (smoke.score === 0) findings.push({ level: "fail", hint: "The model never kept the fleet's tool-call contract, so every seat turn will fail the same way: choose a larger or tool-trained model, and check its chat template." });
  else if (smoke.score < smoke.total) findings.push({ level: "warn", hint: 'Seat turns use this same contract (`{"toolCall":{"name","action":"<tool> <json>"}}`), so they will fail in the same cases: a larger or tool-trained model usually closes them.' });
  if (ttft.timedOut || ttft.ms === undefined) findings.push({ level: "warn", hint: `Every seat turn sends a prompt of this size, so each will wait at least this long for its first token: use a smaller model or quantization, keep it loaded (OLLAMA_KEEP_ALIVE), or faster hardware.` });

  const contextPhrase = context.tokens === undefined
    ? `context window unknown (${context.source})`
    : `context ${context.tokens} tokens (${context.source})${context.tokens < CONTEXT_FLOOR_TOKENS ? `, under ${CONTEXT_FLOOR_TOKENS}` : ""}`;
  const parts = [contextPhrase, slotsPhrase(identity.kind, slots), smokePhrase(smoke), ttftPhrase(ttft, limits.ttftWarnMs)].filter((p): p is string => p !== undefined);
  const status = findings.some((f) => f.level === "fail") ? "fail" : findings.length > 0 ? "warn" : "ok";
  return result({
    status,
    message: `${label} at ${endpoint.url} serves ${primary}: ${parts.join("; ")}.`,
    ...(findings.length === 0 ? {} : { fixHint: [...findings.filter((f) => f.level === "fail"), ...findings.filter((f) => f.level === "warn")].map((f) => f.hint).join(" ") }),
    details: {
      ...runtime,
      models: all,
      ...(show.capabilities === undefined ? {} : { capabilities: show.capabilities }),
      context: { ...context, floor: CONTEXT_FLOOR_TOKENS },
      slots: slots ?? null,
      smoke,
      ttft: { ...ttft, deadlineMs: limits.ttftWarnMs, targetPromptTokens: TTFT_PROMPT_TOKENS },
    },
  });
}

export function createLocalModelCheck(options: LocalModelCheckOptions = {}): DoctorCheck {
  const limits: Required<LocalModelCheckOptions> = {
    smokeCaseTimeoutMs: options.smokeCaseTimeoutMs ?? SMOKE_CASE_TIMEOUT_MS,
    ttftWarnMs: options.ttftWarnMs ?? TTFT_WARN_MS,
    smokeMaxTokens: options.smokeMaxTokens ?? SMOKE_MAX_TOKENS,
  };
  return {
    id: "check_local_model",
    name: LOCAL_MODEL_CATEGORY,
    category: LOCAL_MODEL_CATEGORY,
    timeoutMs: PROBE_ALLOWANCE_MS + SMOKE_CASES.length * limits.smokeCaseTimeoutMs + limits.ttftWarnMs,
    run: (ctx) => run(ctx, limits),
  };
}

export const checkLocalModel: DoctorCheck = createLocalModelCheck();
