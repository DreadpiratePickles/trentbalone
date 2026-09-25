/**
 * `ModelGateway.complete()`: the gateway's own stream, drained into one completion.
 *
 * Moved out of `index.ts` unchanged apart from the [P1-C] fields (`cachedInputTokens`,
 * `reasoningTokens`), so the gateway file stays under the 500-line house limit.
 */

import type { GatewayCompletion, GatewayStreamEvent, ModelProvider, ModelTier } from "./types.js";

export async function collectCompletion(events: AsyncIterable<GatewayStreamEvent>): Promise<GatewayCompletion> {
  let text = "";
  let provider: ModelProvider = "google";
  let model = "";
  let modelTier: ModelTier = "sonnet";
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedInputTokens = 0;
  let reasoningTokens: number | undefined;
  let costCents = 0;
  let estimated = true;
  let pricedAsDefault = true;
  let unpriced = true;
  let providerAlias: string | undefined;
  let finishReason = "stop";

  for await (const event of events) {
    if (event.type === "token") {
      text += event.content;
      provider = event.provider;
      model = event.model;
    } else if (event.type === "usage") {
      provider = event.provider;
      model = event.model;
      modelTier = event.modelTier;
      inputTokens = event.inputTokens;
      outputTokens = event.outputTokens;
      cachedInputTokens = event.cachedInputTokens ?? 0;
      reasoningTokens = event.reasoningTokens;
      costCents = event.costCents;
      estimated = event.estimated;
      pricedAsDefault = event.priced_as_default;
      unpriced = event.unpriced;
      providerAlias = event.providerAlias;
    } else {
      finishReason = event.reason;
    }
  }

  return {
    text,
    provider,
    model,
    modelTier,
    inputTokens,
    outputTokens,
    cachedInputTokens,
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
    costCents,
    estimated,
    priced_as_default: pricedAsDefault,
    unpriced,
    ...(providerAlias === undefined ? {} : { providerAlias }),
    finishReason,
  };
}
