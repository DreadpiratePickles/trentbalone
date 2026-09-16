/**
 * The OTel hook on the orchestrator's event bus.
 *
 * `OTelExporter` was complete and tested but nothing outside a test ever built one, and what it
 * emitted was a flat `gen_ai.agent.turn` per step with no parent. This hook turns the run's event
 * stream into a tree: one `trent.run` span (`run_start` to `run_done|run_failed|run_cancelled`),
 * a child `gen_ai.agent.turn` per step (`step_start` to `step_end|step_blocked`), and a child
 * `execute_tool <adapter>` per tool call record the app attaches to a `step_output` frame.
 *
 * Same shape as the improve loop's `BusHook`: a synchronous sink plus a flush the run awaits. The
 * buffered spans are exported when the run ends and again on `flush()`, so a process that is
 * cancelled mid-run still ships the spans it closed. Redaction is the exporter's: every prompt-
 * shaped string goes through `telemetry/redact.ts` before it is attached.
 */

import type { BusHook } from "../improve/trace-writer.js";
import type { OrcEvent, OrchestrationStepSnapshot } from "../orchestrator/types.js";
import type { ToolCallRecord } from "../tools/types.js";
import { OTelExporter, spanIdFor, traceIdFor, type OTelSpan } from "./OTelExporter.js";

export interface OTelBusHookOptions {
  /** Diagnostic channel for a failed export. Receives the endpoint, never a span body. */
  readonly onError?: (message: string) => void;
}

export interface OTelBusHook extends BusHook {
  readonly exporter: OTelExporter;
}

/** The step as the app's bus actually carries it: the snapshot plus its tool call records. */
type StepFrame = Partial<OrchestrationStepSnapshot> & { toolCalls?: ToolCallRecord[] };

interface StepState {
  readonly spanId: string;
  readonly startNs: number;
  toolsEmitted: number;
  closed: boolean;
}

interface RunState {
  readonly traceId: string;
  readonly spanId: string;
  readonly startNs: number;
  readonly objective: string;
  readonly companyId: string | undefined;
  readonly steps: Map<string, StepState>;
  closed: boolean;
}

const RUN_END: Record<string, string> = { run_done: "completed", run_failed: "failed", run_cancelled: "cancelled" };
const SPAN_KIND_INTERNAL = 1;

const nanos = (iso: string): number => {
  const ms = Date.parse(iso);
  return (Number.isFinite(ms) ? ms : Date.now()) * 1_000_000;
};

export function createOTelBusHook(exporter: OTelExporter, options: OTelBusHookOptions = {}): OTelBusHook {
  const runs = new Map<string, RunState>();
  const pending = new Set<Promise<void>>();

  const runFor = (event: OrcEvent): RunState => {
    let run = runs.get(event.runId);
    if (!run) {
      run = {
        traceId: traceIdFor(event.runId),
        spanId: spanIdFor(event.runId, "run"),
        startNs: nanos(event.at),
        objective: event.run?.objective ?? "",
        companyId: event.run?.companyId,
        steps: new Map(),
        closed: false,
      };
      runs.set(event.runId, run);
    }
    return run;
  };

  const stepFor = (event: OrcEvent, run: RunState, stepId: string): StepState => {
    let step = run.steps.get(stepId);
    if (!step) {
      step = { spanId: spanIdFor(event.runId, `step:${stepId}`), startNs: nanos(event.at), toolsEmitted: 0, closed: false };
      run.steps.set(stepId, step);
    }
    return step;
  };

  const emitTools = (event: OrcEvent, run: RunState, step: StepState, frame: StepFrame): void => {
    const calls = frame.toolCalls ?? [];
    for (let index = step.toolsEmitted; index < calls.length; index += 1) {
      const call = calls[index]!;
      const span: OTelSpan = {
        traceId: run.traceId,
        spanId: spanIdFor(event.runId, `step:${frame.id}:tool:${index}`),
        parentSpanId: step.spanId,
        name: `execute_tool ${call.adapter}`,
        kind: SPAN_KIND_INTERNAL,
        startTimeUnixNano: step.startNs,
        endTimeUnixNano: nanos(event.at),
        attributes: {
          "gen_ai.operation.name": "execute_tool",
          "gen_ai.tool.name": call.adapter,
          "trent.tool.action": call.action,
          "trent.tool.status": call.status,
          "trent.tool.summary": exporter.redactSecrets(call.summary ?? ""),
        },
      };
      exporter.recordSpan(span);
    }
    step.toolsEmitted = Math.max(step.toolsEmitted, calls.length);
  };

  const closeStep = (run: RunState, step: StepState, frame: StepFrame, endAt: string): void => {
    if (step.closed) return;
    step.closed = true;
    const attributes: OTelSpan["attributes"] = {
      "gen_ai.agent.id": frame.agentRole ?? "",
      "gen_ai.agent.role": frame.agentRole ?? "",
      "trent.step.id": frame.id ?? "",
      "trent.step.title": frame.title ?? "",
      "trent.step.status": frame.status ?? "unfinished",
      "gen_ai.tool_calls.count": frame.toolCalls?.length ?? 0,
    };
    if (frame.model) attributes["gen_ai.request.model"] = frame.model;
    if (typeof frame.tokens === "number") attributes["gen_ai.usage.total_tokens"] = frame.tokens;
    if (typeof frame.costCents === "number") attributes["trent.cost_cents"] = frame.costCents;
    if (frame.output) attributes["gen_ai.completion"] = exporter.redactSecrets(frame.output);
    exporter.recordSpan({
      traceId: run.traceId,
      spanId: step.spanId,
      parentSpanId: run.spanId,
      name: "gen_ai.agent.turn",
      kind: SPAN_KIND_INTERNAL,
      startTimeUnixNano: step.startNs,
      endTimeUnixNano: nanos(endAt),
      attributes,
    });
  };

  const closeRun = (event: OrcEvent, run: RunState, status: string): void => {
    if (run.closed) return;
    run.closed = true;
    for (const [stepId, step] of run.steps) closeStep(run, step, { id: stepId, status: "running" }, event.at);
    const attributes: OTelSpan["attributes"] = {
      "trent.run.id": event.runId,
      "trent.run.status": status,
      "trent.run.objective": exporter.redactSecrets(run.objective),
      "trent.run.steps": run.steps.size,
    };
    if (run.companyId) attributes["trent.company.id"] = run.companyId;
    if (event.detail) attributes["trent.run.detail"] = exporter.redactSecrets(event.detail);
    exporter.recordSpan({
      traceId: run.traceId,
      spanId: run.spanId,
      name: "trent.run",
      kind: SPAN_KIND_INTERNAL,
      startTimeUnixNano: run.startNs,
      endTimeUnixNano: nanos(event.at),
      attributes,
    });
    runs.delete(event.runId);
  };

  const exportBuffered = (): Promise<void> => {
    const task = exporter
      .flush()
      .then((ok) => {
        if (!ok) options.onError?.(`OTel export to ${exporter.getEndpoint()} failed; ${exporter.getBufferedCount()} span(s) still buffered`);
      })
      .catch((error: unknown) => {
        options.onError?.(`OTel export to ${exporter.getEndpoint()} threw: ${error instanceof Error ? error.message : String(error)}`);
      });
    pending.add(task);
    void task.finally(() => pending.delete(task));
    return task;
  };

  const sink = (event: OrcEvent): void => {
    const run = runFor(event);
    const frame = event.step as StepFrame | undefined;
    switch (event.kind) {
      case "step_start":
        if (frame?.id) stepFor(event, run, frame.id);
        return;
      case "step_output":
        if (frame?.id) emitTools(event, run, stepFor(event, run, frame.id), frame);
        return;
      case "step_end":
      case "step_blocked":
        if (!frame?.id) return;
        emitTools(event, run, stepFor(event, run, frame.id), frame);
        closeStep(run, stepFor(event, run, frame.id), frame, event.at);
        return;
      case "run_done":
      case "run_failed":
      case "run_cancelled":
        closeRun(event, run, RUN_END[event.kind] ?? event.kind);
        void exportBuffered();
        return;
      default:
        return;
    }
  };

  return {
    exporter,
    sink,
    async flush() {
      while (pending.size > 0) await Promise.all([...pending]);
      if (exporter.getBufferedCount() > 0) await exportBuffered();
    },
  };
}

/** One hook that fans every event out to each of `hooks` and whose flush awaits them all. */
export function composeBusHooks(...hooks: BusHook[]): BusHook {
  if (hooks.length === 1) return hooks[0]!;
  return {
    sink: (event) => {
      for (const hook of hooks) hook.sink(event);
    },
    async flush() {
      await Promise.all(hooks.map((hook) => hook.flush()));
    },
  };
}
