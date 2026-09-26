/**
 * [L2] The decisions `setup --mode local` makes, as pure functions over what the runtimes reported:
 * which runtime, which chat model, which embedding model, and the config keys that follow.
 *
 * Roles (01_discovery/output/local-models-2026-09-26.md §6: one chat model for every role where
 * memory allows, a small embedder resident beside it, whisper for audio):
 *   - chat: the memory tier's model (`local-tiers.ts`, L0-3), else a smaller tier's model already
 *     pulled, else the one model a llama.cpp server serves. Never an Ollama cloud model, never a model
 *     whose runtime says it cannot call tools.
 *   - embedding: `qwen3-embedding:0.6b` (Q8_0, 639 MB; the one with a recorded recall floor,
 *     `fleet-memory/embedder-calibration.ts`), else another Qwen3-Embedding size, else
 *     `nomic-embed-text`; §3. None pulled: `memory.embedder.provider: none`, lexical recall, said so.
 *   - audio: whisper belongs to the `media` toolset (docs/media.md); setup does not choose it.
 */

import type { TrentConfig } from "../config/schema.js";
import { PROVIDER_ALIAS_ROUTES, aliasBaseUrl } from "../model-gateway/providers.js";
import { RUNTIME_LABEL, serverRoot, type LocalModelInfo, type ModelRole, type RuntimeFound, type RuntimeKind, type RuntimeProbe } from "./local-detect.js";
import { START_COMMAND, type LocalProvider } from "./local-runtime.js";
import { LOCAL_TIERS, tierForMemory, tierForModel, type LocalTier, type MemoryTierId } from "./local-tiers.js";

export const DEFAULT_LOCAL_EMBEDDER = "qwen3-embedding:0.6b";
/** Ollama's download size for `qwen3-embedding:0.6b` (`/api/tags` size 639150858 bytes, 2026-09-26). */
export const DEFAULT_LOCAL_EMBEDDER_DOWNLOAD = "639 MB";
const EMBEDDER_PREFERENCE: readonly RegExp[] = [/qwen3-embedding[-:]0\.6b/i, /qwen3-embedding/i, /nomic-embed-text/i];

export type EmbedderProvider = "ollama" | "lmstudio" | "none";
export type ChatSource = "requested" | "recommended" | "fallback" | "served" | "pulled";

/** One runtime as the plan reports it: the JSON a script reads. */
export interface PlanRuntime {
  readonly runtime?: RuntimeKind;
  /** Where it was probed: `ollama`, `lmstudio` (the gateway's URLs) or `base-url`. */
  readonly probed: string;
  readonly url: string;
  readonly reachable: boolean;
  readonly version?: string;
  readonly error?: string;
  readonly models?: ReadonlyArray<{ id: string; size?: string; sizeBytes?: number; role: ModelRole; capabilities?: readonly string[] }>;
}

export interface LocalSetupPlan {
  dryRun: boolean;
  memoryGb: number;
  tier: MemoryTierId;
  runtimes: PlanRuntime[];
  runtime?: RuntimeKind;
  url?: string;
  provider?: LocalProvider;
  chat: { recommended: string; model?: string; source?: ChatSource; pulled?: boolean; thinking?: boolean };
  embedder: { provider: EmbedderProvider; model?: string; pulled?: boolean };
  docker?: boolean;
  mode?: "solo" | "fleet";
  /** Models pulled by this run (or, on a dry run, that it would offer to pull). */
  pull: string[];
  /** Non-secret variables written to the profile `.env` (the alias's base URL). */
  env?: Record<string, string>;
  /** Every config key written (or, on a dry run, that would be), dotted. */
  writes: Record<string, string>;
  expectation?: string;
}

/** Sizes the way `ollama list` prints them: 6.6 GB, 639 MB. */
export function formatSize(bytes: number | undefined): string | undefined {
  if (bytes === undefined || bytes <= 0) return undefined;
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}

export function planRuntime(probe: RuntimeProbe): PlanRuntime {
  if (!probe.reachable) return { probed: probe.source, url: probe.url, reachable: false, error: probe.error };
  return {
    runtime: probe.kind,
    probed: probe.source,
    url: probe.url,
    reachable: true,
    ...(probe.version === undefined ? {} : { version: probe.version }),
    models: probe.models.map((m) => ({
      id: m.id,
      ...(formatSize(m.sizeBytes) === undefined ? {} : { size: formatSize(m.sizeBytes)!, sizeBytes: m.sizeBytes! }),
      role: m.role,
      ...(m.capabilities === undefined ? {} : { capabilities: m.capabilities }),
    })),
  };
}

/** Ollama is the `ollama` alias; LM Studio, a llama.cpp server and any other are reached as `lmstudio`. */
export function providerFor(kind: RuntimeKind): LocalProvider {
  return kind === "ollama" ? "ollama" : "lmstudio";
}

const where = (probe: RuntimeProbe): string =>
  probe.source === "base-url" ? `--base-url ${probe.url}` : `${probe.source === "ollama" ? "Ollama" : "LM Studio"} at ${probe.url}`;

export type RuntimeChoice = { ok: true; runtime: RuntimeFound } | { ok: false; message: string };

/** The named `--base-url` wins; then `--provider`; then Ollama, then LM Studio. Nothing answering refuses. */
export function chooseRuntime(probes: readonly RuntimeProbe[], input: { baseUrl?: string; provider?: string }): RuntimeChoice {
  const named = probes.find((p) => p.source === "base-url");
  if (named !== undefined) {
    return named.reachable
      ? { ok: true, runtime: named }
      : { ok: false, message: `Nothing usable answered at --base-url ${named.url} (${named.error}). Start the server there (for llama.cpp: llama-server --jinja -m <model.gguf> --port <port>), then run setup again.` };
  }
  const order = input.provider === "lmstudio" ? ["lmstudio", "ollama"] : ["ollama", "lmstudio"];
  for (const source of order) {
    const probe = probes.find((p) => p.source === source);
    if (probe?.reachable) return { ok: true, runtime: probe };
  }
  const tried = probes.map((p) => `${where(p)} (${p.reachable ? "answered" : p.error})`).join("; ");
  return {
    ok: false,
    message: `No local model runtime answered: ${tried}. Start one (${START_COMMAND.ollama}, or ${START_COMMAND.lmstudio}), or pass --base-url for a llama.cpp llama-server, then run setup again.`,
  };
}

const sameModel = (a: string, b: string): boolean => a.trim().replace(/:latest$/, "").toLowerCase() === b.trim().replace(/:latest$/, "").toLowerCase();
/** Known to be unable to call tools: its runtime lists capabilities and `tools` is not among them. */
const cannotCallTools = (m: LocalModelInfo): boolean => m.capabilities !== undefined && !m.capabilities.includes("tools");

function tierPick(runtime: RuntimeFound, tier: LocalTier): LocalModelInfo | undefined {
  const chat = runtime.models.filter((m) => m.role === "chat" && !cannotCallTools(m));
  if (runtime.kind === "ollama") return chat.find((m) => sameModel(m.id, tier.ollama)) ?? chat.find((m) => tierForModel(m.id)?.id === tier.id);
  return chat.find((m) => tierForModel(m.id)?.id === tier.id);
}

export interface ChatChoice {
  recommended: string;
  model?: string;
  source?: ChatSource;
  /** Ollama: pull this first (after a confirmation), then use `model`. */
  pull?: string;
  /** What to use if that pull is declined: a smaller tier's model already pulled. */
  fallback?: string;
  /** Why no model was chosen, when none was: one line, for the refusal. */
  missing?: string;
  /** The model that is absent, when that is why (its pull line is printed on Ollama). */
  missingModel?: string;
  notes: string[];
}

function notPulled(runtime: RuntimeFound, model: string): string {
  if (runtime.kind === "ollama") return `${model} is not pulled into Ollama at ${runtime.url}. Run: ollama pull ${model} (or run setup again with --pull), then run setup again.`;
  return `${RUNTIME_LABEL[runtime.kind]} at ${runtime.url} has no model ${model}. Download and load it there, or run setup again with --model set to an id from the list above.`;
}

export function chooseChat(runtime: RuntimeFound, input: { requested?: string; totalMemoryBytes: number; pull: boolean }): ChatChoice {
  const tier = tierForMemory(input.totalMemoryBytes);
  const below = LOCAL_TIERS.slice(0, LOCAL_TIERS.findIndex((t) => t.id === tier.id)).reverse();
  const smaller = below.map((t) => ({ t, m: tierPick(runtime, t) })).find((x) => x.m !== undefined);
  const recommended = runtime.kind === "ollama" ? tier.ollama : tierPick(runtime, tier)?.id ?? tier.lmstudio;

  if (input.requested !== undefined) {
    const listed = runtime.models.find((m) => sameModel(m.id, input.requested!));
    if (listed?.role === "cloud") return { recommended, missing: `${listed.id} is an Ollama cloud model: it runs on ollama.com, not on this machine. Pick a local model, or drop --model for the recommendation.`, notes: [] };
    if (listed !== undefined) {
      const notes = cannotCallTools(listed) ? [`${listed.id} does not list the tools capability, so Trent's tool calls on it will mostly fail.`] : [];
      return { recommended, model: listed.id, source: "requested", notes };
    }
    if (runtime.kind === "ollama" && input.pull) return { recommended, model: input.requested, source: "pulled", pull: input.requested, notes: [] };
    return { recommended, missing: notPulled(runtime, input.requested), missingModel: input.requested, notes: [] };
  }

  if (runtime.kind === "llama.cpp" || runtime.kind === "openai-compatible") {
    const served = runtime.models.find((m) => m.role === "chat");
    if (served === undefined) return { recommended, missing: `${RUNTIME_LABEL[runtime.kind]} at ${runtime.url} lists no chat model (GET /v1/models).`, notes: [] };
    const known = tierForModel(served.id) !== undefined;
    return { recommended, model: served.id, source: "served", notes: known ? [] : [`Trent has no measurement for ${served.id}; the ${tier.memory} tier's model is ${tier.lmstudio} (${tier.ollama} on Ollama).`] };
  }

  const pick = tierPick(runtime, tier);
  if (pick !== undefined) return { recommended, model: pick.id, source: "recommended", notes: [] };
  if (runtime.kind === "ollama" && input.pull) {
    return { recommended, model: tier.ollama, source: "pulled", pull: tier.ollama, ...(smaller === undefined ? {} : { fallback: smaller.m!.id }), notes: [] };
  }
  if (smaller !== undefined) {
    const move = runtime.kind === "ollama" ? `ollama pull ${tier.ollama} (or run setup again with --pull)` : `download ${tier.lmstudio} in LM Studio`;
    return { recommended, model: smaller.m!.id, source: "fallback", notes: [`${recommended} is not there yet, so setup uses ${smaller.m!.id}, the ${smaller.t.memory} tier's model, which is. To move up: ${move}, then run setup again.`] };
  }
  return { recommended, missing: notPulled(runtime, recommended), missingModel: recommended, notes: [] };
}

export interface EmbedderChoice {
  provider: EmbedderProvider;
  model?: string;
  /** The runtime that serves it (its root). */
  url?: string;
  /** Ollama: pull this first, after a confirmation. */
  pull?: string;
  notes: string[];
}

/** An embedding model on the chat runtime first, then on any other runtime that answered. */
export function chooseEmbedder(probes: readonly RuntimeProbe[], chosen: RuntimeFound, pull: boolean): EmbedderChoice {
  const candidates = [chosen, ...probes.filter((p): p is RuntimeFound => p.reachable && p !== chosen)].filter((p) => p.kind === "ollama" || p.kind === "lmstudio");
  for (const pattern of EMBEDDER_PREFERENCE) {
    for (const runtime of candidates) {
      const found = runtime.models.find((m) => m.role === "embedding" && pattern.test(m.id));
      if (found !== undefined) return { provider: providerFor(runtime.kind) as EmbedderProvider, model: found.id, url: runtime.url, notes: [] };
    }
  }
  const ollama = candidates.find((p) => p.kind === "ollama");
  if (ollama !== undefined && pull) return { provider: "ollama", model: DEFAULT_LOCAL_EMBEDDER, url: ollama.url, pull: DEFAULT_LOCAL_EMBEDDER, notes: [] };
  const how = ollama !== undefined
    ? `ollama pull ${DEFAULT_LOCAL_EMBEDDER} (${DEFAULT_LOCAL_EMBEDDER_DOWNLOAD}), then run setup again`
    : candidates.some((p) => p.kind === "lmstudio")
      ? "download text-embedding-qwen3-embedding-0.6b (or nomic-embed-text) in LM Studio, then run setup again"
      : `run Ollama beside it and ollama pull ${DEFAULT_LOCAL_EMBEDDER}, then run setup again`;
  return { provider: "none", notes: [`No embedding model (qwen3-embedding or nomic-embed-text) is there, so recall stays lexical (memory.embedder.provider none). For semantic recall: ${how}.`] };
}

/** The alias's base URL for the profile `.env`, when the chosen server is not where the alias already points. */
export function aliasEnvFor(runtime: RuntimeFound, env: NodeJS.ProcessEnv): Record<string, string> | undefined {
  const provider = providerFor(runtime.kind);
  const want = `${runtime.url}/v1`;
  if (serverRoot(aliasBaseUrl(provider, env)) === runtime.url) return undefined;
  return { [PROVIDER_ALIAS_ROUTES[provider].baseUrlEnv]: want };
}

export interface WritesInput {
  provider: LocalProvider;
  model: string;
  embedder: EmbedderChoice;
  /** Where the embedder resolves by default; a different runtime root is written as `base_url`. */
  embedderDefaultRoot?: string;
  docker: boolean;
  mode: "solo" | "fleet";
  thinkingOff: boolean;
}

export function localWrites(input: WritesInput): Record<string, string> {
  const writes: Record<string, string> = { provider: input.provider, model: input.model, "memory.embedder.provider": input.embedder.provider };
  if (input.embedder.model !== undefined) writes["memory.embedder.model"] = input.embedder.model;
  if (input.embedder.url !== undefined && input.embedderDefaultRoot !== undefined && input.embedder.url !== input.embedderDefaultRoot) {
    writes["memory.embedder.base_url"] = input.embedder.provider === "ollama" ? input.embedder.url : `${input.embedder.url}/v1`;
  }
  if (!input.docker) writes["terminal.backend"] = "local";
  writes["agent.mode"] = input.mode;
  if (input.thinkingOff) writes["models.reasoning_effort"] = "none";
  return writes;
}

type Embedder = TrentConfig["memory"]["embedder"];

/** `config` with the plan's keys applied; every other key, and every sibling, kept. */
export function applyLocalWrites(config: TrentConfig, writes: Readonly<Record<string, string>>): TrentConfig {
  const { model: _model, base_url: _base, ...embedderRest } = config.memory.embedder as Embedder & { base_url?: string };
  const embedder = {
    ...embedderRest,
    provider: writes["memory.embedder.provider"] as Embedder["provider"],
    ...(writes["memory.embedder.model"] === undefined ? {} : { model: writes["memory.embedder.model"] }),
    ...(writes["memory.embedder.base_url"] === undefined ? {} : { base_url: writes["memory.embedder.base_url"] }),
  } as Embedder;
  return {
    ...config,
    provider: writes.provider as TrentConfig["provider"],
    model: writes.model!,
    memory: { ...config.memory, embedder },
    ...(writes["terminal.backend"] === undefined ? {} : { terminal: { ...config.terminal, backend: "local" as const } }),
    agent: { ...config.agent, mode: writes["agent.mode"] as "solo" | "fleet" },
    ...(writes["models.reasoning_effort"] === undefined ? {} : { models: { ...config.models, reasoning_effort: "none" as const } }),
  };
}
