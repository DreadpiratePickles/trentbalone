/**
 * One provider, up to N attempts (harness audit A.4, shortfall D-6).
 *
 * Split out of `index.ts` so the retry state machine is readable on its own and the gateway file
 * stays under the 500-line house limit. It yields flat outcomes and never formats an event: the
 * pricing, the meter row and the fallback decision stay in the gateway.
 *
 * The invariant that shapes everything: ONCE A TOKEN HAS BEEN YIELDED the answer is half-delivered.
 * From that point there is no retry and no fallback, because either one would replay part of an
 * answer the reader already has.
 */

import type { ReasoningEffort } from "./call-policy.js";
import { abortableSleep, classifyProviderError, retryDelayMs, type RetryPolicy } from "./retry.js";
import type { GatewayMessage, ModelProvider, ProviderStreamFn, ProviderStreamFrame } from "./types.js";

export interface AttemptContext {
  readonly streamFn: ProviderStreamFn;
  readonly provider: ModelProvider;
  readonly model: string;
  readonly messages: GatewayMessage[];
  readonly temperature: number;
  readonly maxTokens: number;
  /** [P1-C] Handed to the stream function only when set, so an unconfigured call is unchanged. */
  readonly reasoningEffort?: ReasoningEffort;
  readonly signal?: AbortSignal;
  readonly retryPolicy: RetryPolicy;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly random?: () => number;
  readonly log: (event: string, fields: Record<string, unknown>) => void;
  /** Merged into every log line so an aliased run is identifiable. Never carries a secret. */
  readonly logFields?: Record<string, unknown>;
}

export type AttemptOutcome =
  | { readonly kind: "token"; readonly content: string }
  | {
      readonly kind: "complete";
      readonly sawUsage: boolean;
      readonly inputTokens: number;
      readonly outputTokens: number;
      /** [P1-C] 0 when the provider reported no cache hits. */
      readonly cachedInputTokens: number;
      readonly reasoningTokens: number;
      readonly finishReason?: string;
      readonly text: string;
      readonly aborted: boolean;
    }
  | { readonly kind: "aborted" }
  | { readonly kind: "failed"; readonly error: unknown; readonly emittedToken: boolean };

/** One pull from the upstream generator, racing the run's cancellation. */
type Step =
  | { kind: "frame"; frame: ProviderStreamFrame }
  | { kind: "done" }
  | { kind: "aborted" };

async function nextStep(
  iterator: AsyncGenerator<ProviderStreamFrame>,
  signal: AbortSignal | undefined,
): Promise<Step> {
  const pending: Promise<Step> = iterator
    .next()
    .then((result) => (result.done === true ? { kind: "done" } : { kind: "frame", frame: result.value }));
  if (signal === undefined) return pending;
  if (signal.aborted) {
    void pending.catch(() => undefined);
    return { kind: "aborted" };
  }
  let onAbort: (() => void) | undefined;
  const abortPromise = new Promise<Step>((resolve) => {
    onAbort = () => resolve({ kind: "aborted" });
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    const step = await Promise.race([pending, abortPromise]);
    // The loser of the race must not become an unhandled rejection.
    if (step.kind === "aborted") void pending.catch(() => undefined);
    return step;
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

export async function* runProviderAttempts(ctx: AttemptContext): AsyncGenerator<AttemptOutcome> {
  const sleep = ctx.sleep ?? abortableSleep;
  const extra = ctx.logFields ?? {};
  let emittedToken = false;
  let failure: unknown;

  for (let attempt = 1; attempt <= ctx.retryPolicy.attempts; attempt++) {
    let aborted = false;
    let failed = false;
    let sawUsage = false;
    let inputTokens = 0;
    let outputTokens = 0;
    let cachedInputTokens = 0;
    let reasoningTokens = 0;
    let finishReason: string | undefined;
    let text = "";

    const iterator = ctx.streamFn(ctx.provider, ctx.model, {
      messages: ctx.messages,
      temperature: ctx.temperature,
      maxTokens: ctx.maxTokens,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
      ...(ctx.reasoningEffort === undefined ? {} : { reasoningEffort: ctx.reasoningEffort }),
    });

    try {
      for (;;) {
        const step = await nextStep(iterator, ctx.signal);
        if (step.kind === "aborted") {
          aborted = true;
          break;
        }
        if (step.kind === "done") break;
        const frame = step.frame;
        if (frame.type === "token") {
          emittedToken = true;
          text += frame.content;
          yield { kind: "token", content: frame.content };
          if (ctx.signal?.aborted) {
            aborted = true;
            break;
          }
        } else if (frame.type === "usage") {
          sawUsage = true;
          inputTokens = frame.inputTokens;
          outputTokens = frame.outputTokens;
          cachedInputTokens = frame.cachedInputTokens ?? 0;
          reasoningTokens = frame.reasoningTokens ?? 0;
        } else if (frame.type === "finish") {
          finishReason = frame.reason;
        }
      }
    } catch (error) {
      // Trap 5: branch on signal.aborted, NOT on error.name — an abort carrying a reason does
      // not produce name "AbortError".
      if (ctx.signal?.aborted) aborted = true;
      else {
        failed = true;
        failure = error;
      }
    } finally {
      // Closes the upstream reader / aborts the SDK stream controller.
      if (aborted || failed) void iterator.return(undefined).catch(() => undefined);
    }

    if (!failed) {
      yield {
        kind: "complete",
        sawUsage,
        inputTokens,
        outputTokens,
        cachedInputTokens,
        reasoningTokens,
        text,
        aborted,
        ...(finishReason === undefined ? {} : { finishReason }),
      };
      return;
    }

    const classified = classifyProviderError(failure);
    if (emittedToken || !classified.retryable || attempt >= ctx.retryPolicy.attempts) break;

    const delayMs = retryDelayMs({
      attempt,
      policy: ctx.retryPolicy,
      ...(classified.retryAfterMs === undefined ? {} : { retryAfterMs: classified.retryAfterMs }),
      ...(ctx.random ? { random: ctx.random } : {}),
    });
    ctx.log("model_gateway.retry", {
      provider: ctx.provider,
      model: ctx.model,
      attempt,
      attempts: ctx.retryPolicy.attempts,
      delayMs,
      errorClass: classified.errorClass,
      ...(classified.status === undefined ? {} : { status: classified.status }),
      ...extra,
    });
    await sleep(delayMs, ctx.signal);
    if (ctx.signal?.aborted) {
      yield { kind: "aborted" };
      return;
    }
  }

  yield { kind: "failed", error: failure, emittedToken };
}
