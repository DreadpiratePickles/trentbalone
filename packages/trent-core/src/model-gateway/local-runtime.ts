/**
 * [L0-2] A model on the operator's own machine: its time budgets, its concurrency cap, and the
 * transport its calls ride on. Audit G2 (`01_discovery/output/trent-local-path-audit-2026-09-26.md`):
 * the app client's 60 s timeout killed the planner during prefill of a 27B model, three times.
 *
 * BUDGETS. `ttft_seconds` (default 300) runs from the request to the FIRST token, because a local
 * server sends nothing, headers included, until prefill ends (Ollama logged `500 | 59.999s` when the
 * client gave up). After the first token, `idle_seconds` (default 120) bounds each silence.
 * `context_tokens` (default 32768) is the window assumed when the server cannot be asked
 * (`local-probe.ts`). Hosted providers keep the 60 s headers budget (`openai-compat.ts`).
 *
 * CONCURRENCY. Ollama: "OLLAMA_NUM_PARALLEL - The maximum number of parallel requests each model
 * will process at the same time, default 1" (https://docs.ollama.com/faq). LM Studio: "By default,
 * Max Concurrent Predictions is set to 4" (https://lmstudio.ai/docs/app/advanced/parallel-requests).
 * The rest wait HERE, per endpoint and per process, so the wait is not charged to a call's
 * time-to-first-token budget the way a wait in the server's own queue would be.
 *
 * TRANSPORT. Node's `fetch` (undici) stops waiting for headers after 300 s on its own, which would
 * cap any `ttft_seconds` above that and fail with an error naming neither. `node:http` has no
 * built-in timeout, so the budgets above are the only ones a local call has.
 *
 * The config block reaches a gateway built with no arguments through an env bridge, like
 * `model_overrides` and `models.reasoning_effort`. Names only are ever logged.
 */

import http from "node:http";
import https from "node:https";
import { Readable } from "node:stream";

import type { ProviderAlias } from "./providers.js";
import { isReasoningEffort, type ReasoningEffort } from "./call-policy.js"; // [L1]
import { PROVIDER_ALIAS_ROUTES, activeProviderAlias, isLocalAlias } from "./providers.js"; // [L1]

export const LOCAL_MODEL_ENV = {
  ttftSeconds: "TRENT_LOCAL_TTFT_SECONDS",
  idleSeconds: "TRENT_LOCAL_IDLE_SECONDS",
  contextTokens: "TRENT_LOCAL_CONTEXT_TOKENS",
  maxInFlight: "TRENT_LOCAL_MAX_IN_FLIGHT",
  reasoningEffort: "TRENT_LOCAL_REASONING_EFFORT", // [L1]
  constrainedOutput: "TRENT_LOCAL_CONSTRAINED_OUTPUT", // [L1]
} as const;

export const LOCAL_MODEL_DEFAULTS = { ttftSeconds: 300, idleSeconds: 120, contextTokens: 32_768 } as const;

/** Per local alias, from each runtime's own docs (see the header). */
export const DEFAULT_MAX_IN_FLIGHT: Readonly<Record<"ollama" | "lmstudio", number>> = { ollama: 1, lmstudio: 4 };

/** The config keys, for error messages that name the setting to change. */
export const LOCAL_MODEL_SETTINGS = {
  ttftSeconds: "models.local.ttft_seconds",
  idleSeconds: "models.local.idle_seconds",
  contextTokens: "models.local.context_tokens",
  maxInFlight: "models.local.max_in_flight",
  reasoningEffort: "models.local.reasoning_effort", // [L1]
  constrainedOutput: "models.local.constrained_output", // [L1]
  jobTimeoutSeconds: "models.local.job_timeout_seconds", // [L1]
} as const;

/** The `models.local` config block. */
export interface LocalModelConfig {
  readonly ttft_seconds?: number;
  readonly idle_seconds?: number;
  readonly context_tokens?: number;
  readonly max_in_flight?: number;
  // [L1] small models: see `LOCAL_SMALL_MODEL_DEFAULTS` below.
  readonly reasoning_effort?: string;
  readonly constrained_output?: boolean | "all";
  readonly job_timeout_seconds?: number;
}

export interface LocalModelPolicy {
  readonly ttftMs: number;
  readonly idleMs: number;
  readonly contextTokens: number;
  readonly maxInFlight: number;
}

function positiveInt(value: unknown): number | undefined {
  const parsed = typeof value === "string" ? Number(value.trim()) : value;
  return typeof parsed === "number" && Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/** Writes what is configured, and nothing else. Returns the variable NAMES written. */
export function applyLocalModelEnv(local: LocalModelConfig | undefined, env: NodeJS.ProcessEnv = process.env): string[] {
  const written: string[] = [];
  const pairs: Array<[number | undefined, string]> = [
    [local?.ttft_seconds, LOCAL_MODEL_ENV.ttftSeconds],
    [local?.idle_seconds, LOCAL_MODEL_ENV.idleSeconds],
    [local?.context_tokens, LOCAL_MODEL_ENV.contextTokens],
    [local?.max_in_flight, LOCAL_MODEL_ENV.maxInFlight],
  ];
  for (const [value, name] of pairs) {
    const valid = positiveInt(value);
    if (valid === undefined) continue;
    env[name] = String(valid);
    written.push(name);
  }
  // [L1] small models
  if (isReasoningEffort(local?.reasoning_effort)) {
    env[LOCAL_MODEL_ENV.reasoningEffort] = local.reasoning_effort;
    written.push(LOCAL_MODEL_ENV.reasoningEffort);
  }
  if (local?.constrained_output === true || local?.constrained_output === false || local?.constrained_output === "all") {
    env[LOCAL_MODEL_ENV.constrainedOutput] = String(local.constrained_output);
    written.push(LOCAL_MODEL_ENV.constrainedOutput);
  }
  // [/L1]
  return written;
}

/** The budgets for one local alias: the bridge where it holds a positive whole number, else the default. */
export function localModelPolicy(alias: ProviderAlias, env: NodeJS.ProcessEnv = process.env): LocalModelPolicy {
  const read = (name: string, fallback: number): number => positiveInt(env[name]) ?? fallback;
  const inFlightDefault = alias === "lmstudio" ? DEFAULT_MAX_IN_FLIGHT.lmstudio : DEFAULT_MAX_IN_FLIGHT.ollama;
  return {
    ttftMs: read(LOCAL_MODEL_ENV.ttftSeconds, LOCAL_MODEL_DEFAULTS.ttftSeconds) * 1_000,
    idleMs: read(LOCAL_MODEL_ENV.idleSeconds, LOCAL_MODEL_DEFAULTS.idleSeconds) * 1_000,
    contextTokens: read(LOCAL_MODEL_ENV.contextTokens, LOCAL_MODEL_DEFAULTS.contextTokens),
    maxInFlight: read(LOCAL_MODEL_ENV.maxInFlight, inFlightDefault),
  };
}

// [L1] small models ─────────────────────────────────────────────────────────────
//
// THINKING. qwen3.5:9b thinks by default: 1,267 thinking tokens at 3 tok/s on one seat step, and 2
// tokens with thinking off (L0-2 and L0-3, docs/sessions/2026-09-26-harness-landscape.md). A seat or
// the wrapper's consolidator (gateway role `executor`) on a local runtime therefore asks for
// `reasoning_effort: none` unless `models.local.reasoning_effort` names another level; the planner and
// the critic (role `planner`) keep `models.reasoning_effort`. Ollama maps `none` to `think: false`
// (`openai/openai.go` `ThinkingFromReasoningEffort`); `openai-route.ts` still drops the field where the
// provider does not take it.
// CONSTRAINED OUTPUT. `true` (the default): local runtimes decode seat turns under a JSON schema;
// `false`: off; `all`: hosted providers too (`response-format.ts` says which of them can).
// JOB TIMEOUT. The app's per-job timeout (`apps/web/lib/queue.ts`, 10 min) ended a local seat mid-answer;
// `job_timeout_seconds` is written to `TRENT_JOB_TIMEOUT_MS` for a local run (`orchestrator/model-env.ts`).

export const LOCAL_SMALL_MODEL_DEFAULTS = { reasoningEffort: "none", constrainedOutput: true, jobTimeoutSeconds: 1800 } as const;

/** The effort a local executor call asks for: the bridge when it holds a known level, else `none`. */
export function localReasoningEffort(env: NodeJS.ProcessEnv = process.env): ReasoningEffort {
  const value = env[LOCAL_MODEL_ENV.reasoningEffort]?.trim();
  return isReasoningEffort(value) ? value : LOCAL_SMALL_MODEL_DEFAULTS.reasoningEffort;
}

/**
 * The effort a call of `role` gets from the local default: executor calls on a local alias only, and
 * not a call routed explicitly to another provider (a hosted escalation: Gemini 3 refuses `none`).
 */
export function localRoleEffort(role: "executor" | "planner", requestProvider?: string, env: NodeJS.ProcessEnv = process.env): ReasoningEffort | undefined {
  const alias = activeProviderAlias(env);
  if (role !== "executor" || alias === undefined || !isLocalAlias(alias)) return undefined;
  return requestProvider === undefined || requestProvider === PROVIDER_ALIAS_ROUTES[alias].provider ? localReasoningEffort(env) : undefined;
}

/** True when seat turns should be decoded under a schema on the route this process uses. */
export function constrainedOutputApplies(env: NodeJS.ProcessEnv = process.env): boolean {
  const mode = env[LOCAL_MODEL_ENV.constrainedOutput]?.trim().toLowerCase();
  if (mode === "all") return true;
  if (mode === "false") return false;
  const alias = activeProviderAlias(env);
  return alias !== undefined && isLocalAlias(alias);
}

/** `models.local.job_timeout_seconds` in milliseconds, or the default. */
export function localJobTimeoutMs(local: LocalModelConfig | undefined): number {
  return (positiveInt(local?.job_timeout_seconds) ?? LOCAL_SMALL_MODEL_DEFAULTS.jobTimeoutSeconds) * 1_000;
}
// [/L1]

// ── the in-flight cap ──────────────────────────────────────────────────────────

interface Lane {
  active: number;
  readonly waiting: Array<() => void>;
}

/** Process-wide, keyed by endpoint: every gateway in this process shares one local server's slots. */
const lanes = new Map<string, Lane>();

function abortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason : Object.assign(new Error("aborted while waiting for a local model slot"), { name: "AbortError" });
}

/**
 * Waits for one of `limit` slots on `key` (first come, first served) and returns its release. A
 * caller cancelled while waiting leaves the queue and gets the abort as an error; it never sends.
 */
export function acquireLocalSlot(key: string, limit: number, signal?: AbortSignal): Promise<() => void> {
  const lane = lanes.get(key) ?? { active: 0, waiting: [] };
  lanes.set(key, lane);
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    lane.active -= 1;
    lane.waiting.shift()?.();
  };
  if (signal?.aborted) return Promise.reject(abortError(signal));
  if (lane.active < Math.max(1, limit)) {
    lane.active += 1;
    return Promise.resolve(release);
  }
  return new Promise((resolve, reject) => {
    const admit = (): void => {
      signal?.removeEventListener("abort", onAbort);
      lane.active += 1;
      resolve(release);
    };
    const onAbort = (): void => {
      const index = lane.waiting.indexOf(admit);
      if (index >= 0) lane.waiting.splice(index, 1);
      reject(abortError(signal!));
    };
    lane.waiting.push(admit);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// ── the transport ──────────────────────────────────────────────────────────────

/** `fetch` over `node:http(s)`, with no timeout of its own: the caller's signal is the only deadline. */
export function localFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const target = new URL(url);
  const client = target.protocol === "https:" ? https : http;
  const headers: Record<string, string> = {};
  new Headers(init.headers).forEach((value, name) => {
    headers[name] = value;
  });
  return new Promise<Response>((resolve, reject) => {
    const request = client.request(target, { method: init.method ?? "GET", headers, ...(init.signal ? { signal: init.signal } : {}) }, (res) => {
      const responseHeaders = new Headers();
      for (const [name, value] of Object.entries(res.headers)) {
        if (typeof value === "string") responseHeaders.set(name, value);
        else if (Array.isArray(value)) for (const one of value) responseHeaders.append(name, one);
      }
      const status = res.statusCode ?? 502;
      const body = status === 204 || status === 304 ? null : (Readable.toWeb(res) as ReadableStream<Uint8Array>);
      resolve(new Response(body, { status, statusText: res.statusMessage ?? "", headers: responseHeaders }));
    });
    request.on("error", reject);
    if (typeof init.body === "string") request.write(init.body);
    request.end();
  });
}
