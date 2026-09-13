/**
 * The single object a surface hands to `createOrchestrator({ improve })`: the trace writer and the
 * golden capture composed into one bus hook. The orchestrator wrapper calls `sink` for every event
 * on every run and awaits `flush()` before the run's result settles, so a caller that runs a
 * session and then sweeps sees every trace the session produced.
 */

import { createGoldenCapture, type GoldenCapture } from "./golden-capture.js";
import { createTraceWriter, type BusHook, type TraceWriterOptions } from "./trace-writer.js";

export interface ImproveHookOptions extends TraceWriterOptions {
  /** Where failure goldens go. Omit to disable capture (tests that only want traces). */
  readonly goldenDir?: string;
}

export interface ImproveHook extends BusHook {
  readonly goldens: GoldenCapture | undefined;
}

export function createImproveHook(options: ImproveHookOptions): ImproveHook {
  const traces = createTraceWriter(options);
  const goldens = options.goldenDir === undefined ? undefined : createGoldenCapture({ dir: options.goldenDir, onError: options.onError });
  const hooks: BusHook[] = goldens ? [traces, goldens] : [traces];
  return {
    goldens,
    sink: (event) => {
      for (const hook of hooks) hook.sink(event);
    },
    async flush() {
      await Promise.all(hooks.map((hook) => hook.flush()));
    },
  };
}
