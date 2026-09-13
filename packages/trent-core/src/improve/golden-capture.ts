/**
 * Item 4 of the loop — golden capture.
 *
 * `captureOrchestrationFailureGolden` had no caller. This hook calls it from the bus: on
 * `run_failed`, and on a critic `escalate` / `replan`, the failing run's objective becomes a
 * QUARANTINED regression fixture (secrets redacted by the lib's `sanitizeGoldenText`). A human
 * promotes it to blocking through code review, as the lib intends. One golden per run.
 *
 * Wraps: apps/web/lib/orchestration-golden-capture.ts (capture, list, sanitize).
 */

import type { OrcEvent, TraceSink } from "../orchestrator/types.js";
import type { BusHook } from "./trace-writer.js";

export interface CapturedGolden {
  id: string;
  runId: string;
  status: "quarantined" | "blocking";
  companyId?: string;
  objective?: string;
  reason?: string;
  trajectoryFailureTags?: string[];
  capturedAt?: string;
}

export type GoldenCaptureFn = (input: { runId: string; reason: string; dir: string }) => Promise<CapturedGolden | undefined>;

export interface GoldenCaptureOptions {
  /** Where fixtures are written. Always explicit, so the lib's test-runner gate never swallows a capture. */
  readonly dir: string;
  /** Injected for offline tests; defaults to the wrapped lib function. */
  readonly capture?: GoldenCaptureFn;
  readonly onError?: (message: string) => void;
}

export interface GoldenCapture extends BusHook {
  list(): Promise<CapturedGolden[]>;
}

async function libCapture(input: { runId: string; reason: string; dir: string }): Promise<CapturedGolden | undefined> {
  const { captureOrchestrationFailureGolden } = await import("@/lib/orchestration-golden-capture");
  return (await captureOrchestrationFailureGolden(input)) as CapturedGolden | undefined;
}

/** The lib's redaction, re-exported so callers can sanitise their own reason strings. */
export async function sanitizeGoldenText(raw: string): Promise<string> {
  const { sanitizeGoldenText: sanitize } = await import("@/lib/orchestration-golden-capture");
  return sanitize(raw);
}

function reasonFor(event: OrcEvent): string | undefined {
  if (event.kind === "run_failed") return `run_failed: ${event.detail ?? "no detail"}`;
  if (event.kind !== "step_critic") return undefined;
  const critique = (event.step as { critique?: { verdict?: string; reason?: string } } | undefined)?.critique;
  if (critique?.verdict !== "escalate" && critique?.verdict !== "replan") return undefined;
  return `critic_${critique.verdict}: ${critique.reason ?? "no reason"}`;
}

export function createGoldenCapture(options: GoldenCaptureOptions): GoldenCapture {
  const capture = options.capture ?? libCapture;
  const captured = new Set<string>();
  const pending = new Set<Promise<void>>();

  const sink: TraceSink = (event) => {
    const reason = reasonFor(event);
    if (reason === undefined || captured.has(event.runId)) return;
    captured.add(event.runId);
    const task = capture({ runId: event.runId, reason, dir: options.dir })
      .then(() => undefined)
      .catch((error: unknown) => {
        options.onError?.(`golden capture failed for run ${event.runId}: ${error instanceof Error ? error.message : String(error)}`);
      });
    pending.add(task);
    void task.finally(() => pending.delete(task));
  };

  return {
    sink,
    async flush() {
      while (pending.size > 0) await Promise.all([...pending]);
    },
    async list() {
      const { listOrchestrationGoldens } = await import("@/lib/orchestration-golden-capture");
      return (await listOrchestrationGoldens(options.dir)) as CapturedGolden[];
    },
  };
}
