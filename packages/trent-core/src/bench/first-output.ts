/**
 * [C16] Time to first token, as each harness shows it, on the bench's clock.
 *
 * - Trent solo: the gateway itself is wrapped (`timedGateway`), so the first `token` frame of a streamed call
 *   (C13's `stream()`), or the return of the first `complete()` when the call is not streamed, is the mark.
 * - The fleet, whose seats call the app's gateway where nothing can wrap it: the first event that carries
 *   model output (`MODEL_OUTPUT_KINDS`).
 * - Hermes: the first `text` or `tool_use` line of its stream-json (`hermes-stream.ts`).
 */
import type { OrcEvent } from "../orchestrator/types.js";

export interface FirstOutput {
  /** Forget the last mark: a new attempt starts. */
  reset(): void;
  /** Record now, if nothing was recorded since the last reset. */
  mark(): void;
  /** The mark, as the clock's epoch milliseconds. */
  at(): number | undefined;
}

export function createFirstOutput(now: () => number = Date.now): FirstOutput {
  let first: number | undefined;
  return {
    reset: () => {
      first = undefined;
    },
    mark: () => {
      first ??= now();
    },
    at: () => first,
  };
}

/** The events that mean a model has produced something a person could see. `step_delta` is C13's token frame. */
const MODEL_OUTPUT_KINDS: ReadonlySet<string> = new Set(["plan_end", "step_note", "step_delta", "step_critic", "run_done"]);

export function carriesModelOutput(event: OrcEvent): boolean {
  if (MODEL_OUTPUT_KINDS.has(event.kind)) return true;
  if (event.kind !== "step_output") return false;
  const step = event.step as { output?: unknown; toolCalls?: readonly unknown[] } | undefined;
  return (typeof step?.output === "string" && step.output !== "") || (step?.toolCalls?.length ?? 0) > 0;
}

/** The structural slice of a gateway the solo loop calls (`solo/types.ts` SoloGateway), `stream` optional. */
interface CallableGateway {
  complete(request: never): Promise<unknown>;
  stream?(request: never): AsyncIterable<unknown>;
}

function markedStream(source: AsyncIterable<unknown>, clock: FirstOutput): AsyncIterable<unknown> {
  return {
    [Symbol.asyncIterator]() {
      const iterator = source[Symbol.asyncIterator]();
      return {
        async next() {
          const step = await iterator.next();
          // The first token frame; a call that streams no token (a native tool call) marks when it ends, as `complete()` does.
          if (step.done === true || (step.value as { type?: unknown } | undefined)?.type === "token") clock.mark();
          return step;
        },
        return: async (value?: unknown) => (iterator.return === undefined ? { done: true as const, value } : iterator.return(value)),
      };
    },
  };
}

/**
 * The gateway with the first output marked. A Proxy, so whatever else the gateway carries (and whatever C13
 * or a later change adds) is the gateway's own; only `complete` and `stream` are observed.
 */
export function timedGateway<G extends CallableGateway>(inner: G, clock: FirstOutput): G {
  return new Proxy(inner, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      const fn = value as (...args: unknown[]) => unknown;
      if (property === "complete") {
        return async (...args: unknown[]) => {
          const result = await fn.apply(target, args);
          clock.mark();
          return result;
        };
      }
      if (property === "stream") return (...args: unknown[]) => markedStream(fn.apply(target, args) as AsyncIterable<unknown>, clock);
      return fn.bind(target);
    },
  });
}
