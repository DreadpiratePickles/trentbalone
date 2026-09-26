/**
 * [L0-2] The prompt budget of a seat call to a LOCAL model (audit G17).
 *
 * A local runtime that is handed more than its window does not refuse: Ollama "silently discards
 * context that exceeds the window" (research F1, https://aider.chat/docs/llms/ollama.html), so a
 * seat loses its instructions or its tools and answers anyway. The window here is the one the server
 * reports for the model (`model-gateway/local-probe.ts`: Ollama `/api/ps` or a Modelfile `num_ctx`,
 * LM Studio's loaded instance, llama.cpp `/props`), else `models.local.context_tokens`. A call whose
 * prompt plus its output reservation (the seat's `max_tokens`) does not fit is refused BEFORE it is
 * sent, with the sizes, where the window figure came from, and what to trim.
 *
 * Hosted providers are never asked anything here: their windows are large and they reject an
 * oversized request themselves. The prompt is estimated at 4 characters per token, the same
 * estimator as the tiers (`tiers.ts`), over what the hook can see: the seat's system prompt, its
 * dynamic prompt and the objective. The app adds a few lines around them, so this is a floor.
 */

import { EXIT, TrentError } from "../errors/index.js";
import { readContextWindow } from "../model-gateway/local-probe.js";
import { LOCAL_MODEL_SETTINGS, localModelPolicy } from "../model-gateway/local-runtime.js";
import { PROVIDER_ALIAS_ROUTES, activeProviderAlias, aliasBaseUrl, isLocalAlias, type ProviderAlias } from "../model-gateway/providers.js";
import { estimateTokens, type AssembledContext, type SeatPrompts } from "./tiers.js";

/** The app's `MAX_TOKENS.JSON` default, which the seat port sends as `max_tokens` (`OPENAI_MAX_TOKENS_JSON`). */
const DEFAULT_SEAT_MAX_TOKENS = 8_192;

export interface PromptBudgetInput {
  readonly promptTokens: number;
  /** The output the call reserves: its `max_tokens`. */
  readonly reserveTokens: number;
  readonly windowTokens: number;
}

export interface PromptBudgetVerdict extends PromptBudgetInput {
  readonly fits: boolean;
  /** Prompt plus reservation. */
  readonly needTokens: number;
  /** Window minus need; negative when it does not fit. */
  readonly headroomTokens: number;
}

export function evaluatePromptBudget(input: PromptBudgetInput): PromptBudgetVerdict {
  const needTokens = input.promptTokens + input.reserveTokens;
  const headroomTokens = input.windowTokens - needTokens;
  return { ...input, fits: headroomTokens >= 0, needTokens, headroomTokens };
}

/** Sizes of what the hook can see of one seat call, in characters. */
export interface PromptParts {
  readonly seatPromptChars: number;
  readonly stableChars: number;
  readonly contextChars: number;
  readonly volatileChars: number;
  /** The context tier's blocks, largest first: what `context.ceiling_chars` trims. */
  readonly contextBlocks: ReadonlyArray<readonly [string, number]>;
}

export interface PromptBudgetWhere {
  readonly seat: string;
  readonly model: string;
  readonly alias: ProviderAlias;
  readonly windowSource: string;
  readonly parts: PromptParts;
}

const n = (value: number): string => value.toLocaleString("en-US");

/** Which part to trim: the largest one a setting can move, named with that setting. */
function trimAdvice(parts: PromptParts): string {
  const ranked: Array<[string, number]> = [
    ["context", parts.contextChars],
    ["stable", parts.stableChars],
    ["volatile", parts.volatileChars],
    ["seat", parts.seatPromptChars],
  ];
  ranked.sort((a, b) => b[1] - a[1]);
  const [largest, chars] = ranked[0]!;
  if (largest === "context") {
    const blocks = parts.contextBlocks.slice(0, 3).map(([name, size]) => `${name} ${n(size)} chars`).join(", ");
    return `the largest part is the context tier (${n(chars)} chars${blocks ? `: ${blocks}` : ""}); lower context.ceiling_chars to trim it`;
  }
  if (largest === "stable") {
    return `the largest part is the stable tier (${n(chars)} chars: company memory, the brain and workspace context files), which the ceiling never trims; shorten those memory blocks or files`;
  }
  if (largest === "volatile") return `the largest part is the volatile tier (${n(chars)} chars: the conversation so far); start a new session or compact it`;
  return `the largest part is the seat's own prompt and pipeline text (${n(chars)} chars), which no setting trims; use a model with a larger window`;
}

export function promptBudgetMessage(verdict: PromptBudgetVerdict, where: PromptBudgetWhere): string {
  const raise =
    where.alias === "ollama"
      ? "OLLAMA_CONTEXT_LENGTH on the server (e.g. OLLAMA_CONTEXT_LENGTH=65536 ollama serve)"
      : "the model's context length where the server loads it";
  return (
    `seat ${where.seat}: the prompt (~${n(verdict.promptTokens)} tokens, estimated) plus the ${n(verdict.reserveTokens)}-token output reservation needs ` +
    `${n(verdict.needTokens)} tokens, but ${where.model} on ${where.alias} has a ${n(verdict.windowTokens)}-token context window ` +
    `(from ${where.windowSource}); the server would cut the prompt silently, so it was not sent. Raise the window with ${raise}, ` +
    `or set ${LOCAL_MODEL_SETTINGS.contextTokens} if the server cannot be asked; or trim: ${trimAdvice(where.parts)}.`
  );
}

/** The seat's model under a local alias: its tier variable, else the executor model, else the alias default. */
async function seatModel(seat: string, alias: ProviderAlias, env: NodeJS.ProcessEnv): Promise<string> {
  let tierVar: string | undefined;
  try {
    // Lazy: the tier table reads the app's seat manifest, which only a real seat call has loaded.
    tierVar = (await import("../orchestrator/model-env.js")).seatTierVar(seat, "openai");
  } catch {
    tierVar = undefined; // a seat the roster does not name: the executor model
  }
  const pick = (name: string | undefined): string | undefined => (name === undefined ? undefined : env[name]?.trim() || undefined);
  return pick(tierVar) ?? pick("OPENAI_MODEL_DEFAULT") ?? PROVIDER_ALIAS_ROUTES[alias].defaultModel;
}

export interface FitSeatPromptDeps {
  readonly env?: NodeJS.ProcessEnv;
  readonly fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
}

type SeatCall = { readonly subtask: { readonly seat: string; readonly objective?: string } };

/**
 * The hook's check, between placing the tiers and calling the seat. Returns `placed` unchanged when
 * the call fits or the provider is not local; throws a configuration error (exit code 3) when not.
 */
export async function fitSeatPrompt(input: SeatCall, placed: SeatPrompts, assembled: AssembledContext, deps: FitSeatPromptDeps = {}): Promise<SeatPrompts> {
  const env = deps.env ?? process.env;
  const alias = activeProviderAlias(env);
  if (alias === undefined || !isLocalAlias(alias)) return placed;
  const seat = input.subtask.seat;
  const model = await seatModel(seat, alias, env);
  const policy = localModelPolicy(alias, env);
  const baseUrl = env.OPENAI_BASE_URL?.trim() || aliasBaseUrl(alias, env);
  const window = await readContextWindow({ alias, baseUrl, model, fallbackTokens: policy.contextTokens, ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}) });
  const seatChars = (placed.systemPrompt?.length ?? 0) + (placed.dynamicPrompt?.length ?? 0) + (input.subtask.objective?.length ?? 0);
  const reserve = Number.parseInt(env.OPENAI_MAX_TOKENS_JSON ?? "", 10);
  const verdict = evaluatePromptBudget({
    promptTokens: estimateTokens(seatChars),
    reserveTokens: Number.isFinite(reserve) && reserve > 0 ? reserve : DEFAULT_SEAT_MAX_TOKENS,
    windowTokens: window.tokens,
  });
  if (verdict.fits) return placed;
  const injected = assembled.stableChars + assembled.contextChars + assembled.volatileChars;
  const parts: PromptParts = {
    seatPromptChars: Math.max(0, seatChars - injected),
    stableChars: assembled.stableChars,
    contextChars: assembled.contextChars,
    volatileChars: assembled.volatileChars,
    contextBlocks: assembled.kept.filter((b) => b.tier === "context").map((b) => [b.name, b.text.length] as const).sort((a, b) => b[1] - a[1]),
  };
  throw new TrentError({
    code: EXIT.CONFIG,
    operation: "model.prompt_budget",
    message: promptBudgetMessage(verdict, { seat, model, alias, windowSource: window.source, parts }),
    target: model,
    context: { windowTokens: verdict.windowTokens, promptTokens: verdict.promptTokens, reserveTokens: verdict.reserveTokens, windowSource: window.source },
  });
}
