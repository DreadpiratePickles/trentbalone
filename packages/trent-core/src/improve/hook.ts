/**
 * The single object a surface hands to `createOrchestrator({ improve })`: the trace writer and the
 * golden capture composed into one bus hook. The orchestrator wrapper calls `sink` for every event
 * on every run and awaits `flush()` before the run's result settles, so a caller that runs a
 * session and then sweeps sees every trace the session produced.
 *
 * It also carries the skill injector: pass `hook.seatModel(fn)` as `executeSeatModelFn` and every
 * seat call sees the agent's promoted skills, with `skillApplied` on the trace recording that it did.
 */

import path from "node:path";

import { createGoldenCapture, type GoldenCapture } from "./golden-capture.js";
import { RETRIEVAL_GOLDENS_SUBDIR } from "./golden-store.js";
import { createRetrievalCapture, type RetrievalCapture } from "./retrieval-capture.js";
import { createSkillInjector, type SkillInjector } from "./skill-injection.js";
import { createTraceWriter, type BusHook, type TraceWriterOptions } from "./trace-writer.js";

export interface ImproveHookOptions extends TraceWriterOptions {
  /** Where failure goldens go. Omit to disable capture (tests that only want traces). */
  readonly goldenDir?: string;
}

export interface ImproveHook extends BusHook {
  readonly goldens: GoldenCapture | undefined;
  /** [W3] Retrieval goldens captured from `recall` notes, under `<goldenDir>/retrieval`; absent with `goldens`. */
  readonly retrievalGoldens: RetrievalCapture | undefined;
  /** Wraps a seat executor so promoted skills reach the seat (task I.17). */
  readonly seatModel: SkillInjector["seatModel"];
}

export function createImproveHook(options: ImproveHookOptions): ImproveHook {
  const injector = createSkillInjector({
    store: options.store,
    ...(options.resolveAgentId === undefined ? {} : { resolveAgentId: options.resolveAgentId }),
    ...(options.onError === undefined ? {} : { onError: options.onError }),
  });
  const traces = createTraceWriter({ ...options, skillApplied: (stepId) => injector.appliedTo(stepId) });
  const goldens = options.goldenDir === undefined ? undefined : createGoldenCapture({ dir: options.goldenDir, onError: options.onError });
  const retrievalGoldens =
    options.goldenDir === undefined ? undefined : createRetrievalCapture({ dir: path.join(options.goldenDir, RETRIEVAL_GOLDENS_SUBDIR), onError: options.onError });
  const hooks: BusHook[] = goldens && retrievalGoldens ? [traces, goldens, retrievalGoldens] : [traces];
  return {
    goldens,
    retrievalGoldens,
    seatModel: (underlying) => injector.seatModel(underlying),
    sink: (event) => {
      for (const hook of hooks) hook.sink(event);
    },
    async flush() {
      await Promise.all(hooks.map((hook) => hook.flush()));
    },
  };
}
