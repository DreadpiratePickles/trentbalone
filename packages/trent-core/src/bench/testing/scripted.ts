/**
 * [C16] Test seams for the bench: a scripted gateway whose replies a test writes, priced as a named model
 * with fixed token counts, and helpers that write a solo tool call the way a model would (a deferred tool
 * through the bridge's `tool_call`). Nothing here calls a model; every reply a test sees is its own script.
 */
import type { GatewayCompletion, GatewayStreamRequest } from "../../model-gateway/types.js";
import type { SoloGateway } from "../../solo/types.js";

export interface ScriptedBenchGateway extends SoloGateway {
  readonly requests: GatewayStreamRequest[];
}

export interface ScriptedOptions {
  readonly model?: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  /** Milliseconds each reply takes, on the real clock. */
  readonly delayMs?: number;
}

/** A solo reply calling one deferred tool through the bridge. */
export function bridged(tool: string, args: Record<string, unknown>): string {
  return `<tool_call>\ntool_call ${JSON.stringify({ name: tool, arguments: args })}\n</tool_call>`;
}

/** A solo reply calling one advertised tool directly (`read_file`, `write_file`). */
export function direct(tool: string, args: Record<string, unknown>): string {
  return `<tool_call>\n${tool} ${JSON.stringify(args)}\n</tool_call>`;
}

function waitFor(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });
}

/**
 * Replies in order, one script per attempt: `scripts[i]` is the i-th attempt's replies, and a call past the end
 * of its script throws, so an unexpected extra call fails loudly. `"hang"` waits until the run is aborted.
 */
export function scriptedBenchGateway(script: readonly string[], options: ScriptedOptions = {}): ScriptedBenchGateway {
  const requests: GatewayStreamRequest[] = [];
  return {
    requests,
    async complete(request): Promise<GatewayCompletion> {
      requests.push(request);
      const reply = script[requests.length - 1];
      if (reply === undefined) throw new Error(`the bench script has no reply for call ${String(requests.length)}`);
      if (reply === "hang") await waitFor(3_600_000, request.signal);
      if (options.delayMs !== undefined) await waitFor(options.delayMs, request.signal);
      return {
        text: reply,
        provider: "google",
        model: options.model ?? "gemini-3.5-flash-lite",
        modelTier: "sonnet",
        inputTokens: options.inputTokens ?? 1000,
        outputTokens: options.outputTokens ?? 50,
        cachedInputTokens: 0,
        costCents: 1,
        estimated: false,
        priced_as_default: false,
        unpriced: false,
        finishReason: "stop",
      };
    },
  };
}
