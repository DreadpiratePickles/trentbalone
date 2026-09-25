/**
 * [P2-8] The per-run spend meter: every model call a run makes is priced at the list price of the
 * model that ANSWERED, and every cents figure a surface shows is read off the same meter.
 *
 * Before this (docs/sessions/2026-09-25-p1c-model-cost.md, follow-ups 2 and 3):
 *   - a seat call's `costCents` was `apps/web/lib/model-gateway.ts` `estimateModelCostCents`, the
 *     Anthropic TIER price (sonnet = $3.00 per million input) whatever model answered, rounded up to
 *     a whole cent per call — a gemini-3.5-flash-lite tagline run read $0.17 for ~1-2 cents of list;
 *   - the planner, critic and consolidator calls reached no ledger row and no frame at all.
 *
 * What this module installs, per run (`index.ts` `drive`):
 *   - `seatModel`: wraps the seat executor — the app's `executeSeatModel`, or an injected one such as
 *     the improve loop's skill injector (`apps/cli/src/commands/improve.ts`), which forwards its input,
 *     port included, to the app's. When the seat was answered through the wrapper's own port
 *     (`./seat-gateway-port.ts`), the result's `costCents` becomes what the run meter says is newly
 *     due (`run-hooks.ts` `recordRunModelCall`), so `step_end`, the per-seat cap, the REPL ticker and
 *     `trent run` all see list price. A result the port never saw (a fake executor that ignores it)
 *     keeps its own figure, except the app's own cached result replayed for an analyst step: the
 *     app returns the same object it cached, no provider was asked, and it costs 0;
 *   - `portGateway` / `consolidatorGateway`: the gateway the planner/critic port and the wrapper's
 *     consolidator are handed. Each completed call is metered on its own row: `planner` until the
 *     first seat call, `critic` after it (the plan job always precedes the execute jobs), and
 *     `consolidator`;
 *   - `stamp`: `consolidate_end` carries the orchestration charge not yet on a frame. Every surface
 *     already reads a charge off that frame's `step.costCents`; the app never put one there.
 *
 * The ledger rows are written by `run-hooks.ts` when the run closes, apportioned so they add up to
 * the same totals the frames charged.
 */

import type { GatewayCompletion, ModelGateway } from "../model-gateway/types.js";
import { recordRunModelCall, takeOrchestrationCharge } from "./run-hooks.js";
import { isMeteredSeatPort, readSeatCallUsage, type SeatCallUsage } from "./seat-gateway-port.js";
import type { SeatModelFn } from "./seat-guard.js";
import type { OrcEvent, SeatChatCompletionFn } from "./types.js";

export { createSeatChatPort } from "./seat-gateway-port.js";

/** The orchestration roles a metered gateway call is recorded under. */
export type OrchestrationRole = "planner" | "critic" | "consolidator";

export interface RunSpendMeter {
  /** The app's seat executor, its cost replaced by the metered list price when the wrapper's port answered. */
  seatModel(underlying: SeatModelFn): SeatModelFn;
  /** The planner/critic port's gateway: `planner` until the first seat call, `critic` after. */
  portGateway(gateway: ModelGateway): ModelGateway;
  /** The wrapper consolidator's gateway. */
  consolidatorGateway(gateway: ModelGateway): ModelGateway;
  /** `consolidate_end` with the orchestration charge on it; every other event unchanged. */
  stamp(event: OrcEvent): OrcEvent;
}

function modelCall(usage: SeatCallUsage | GatewayCompletion, seat: string, stepId?: string) {
  return {
    seat,
    ...(stepId === undefined ? {} : { stepId }),
    model: usage.model,
    provider: usage.provider,
    ...(usage.providerAlias === undefined ? {} : { providerAlias: usage.providerAlias }),
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cachedInputTokens: usage.cachedInputTokens ?? 0,
    estimated: usage.estimated,
    costCents: usage.costCents,
  };
}

/** `runId` is read at call time: the meter exists before the run has an id. */
export function createRunSpendMeter(runId: () => string | undefined): RunSpendMeter {
  /** Set by the first seat call: the plan job always precedes the execute jobs. */
  let executing = false;
  /** The app's result objects for calls this meter priced: seen again with no call, it is a cache hit. */
  const priced = new WeakSet<object>();

  function metered(gateway: ModelGateway, role: () => OrchestrationRole): ModelGateway {
    return {
      ...gateway,
      complete: async (req) => {
        const completion = await gateway.complete(req);
        recordRunModelCall(runId(), modelCall(completion, role()));
        return completion;
      },
    };
  }

  return {
    seatModel: (underlying) => async (input) => {
      executing = true;
      const port = input.createChatCompletion;
      if (!isMeteredSeatPort(port)) return underlying(input);
      const answered: SeatCallUsage[] = [];
      const observed: SeatChatCompletionFn = async (request) => {
        const reply = await port(request);
        const usage = readSeatCallUsage(reply);
        if (usage !== undefined) answered.push(usage);
        return reply;
      };
      const result = await underlying({ ...input, createChatCompletion: observed });
      if (answered.length === 0) return priced.has(result) ? { ...result, costCents: 0 } : result;
      priced.add(result);
      let costCents = 0;
      for (const usage of answered) {
        costCents += recordRunModelCall(runId(), modelCall(usage, input.subtask.seat, input.subtask.id)) ?? usage.costCents;
      }
      return { ...result, costCents, model: answered.at(-1)?.model ?? result.model };
    },
    portGateway: (gateway) => metered(gateway, () => (executing ? "critic" : "planner")),
    consolidatorGateway: (gateway) => metered(gateway, () => "consolidator"),
    stamp: (event) => {
      if (event.kind !== "consolidate_end") return event;
      const charge = takeOrchestrationCharge(runId());
      if (charge === undefined || (charge.cents === 0 && charge.tokens === 0)) return event;
      const step = event.step ?? {};
      return { ...event, step: { ...step, costCents: (step.costCents ?? 0) + charge.cents, tokens: (step.tokens ?? 0) + charge.tokens } };
    },
  };
}
