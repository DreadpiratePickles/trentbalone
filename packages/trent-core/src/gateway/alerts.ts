/**
 * Push alerts to the gateway owner.
 *
 * Three conditions on a run's event stream become one plain-text message each to `gateway.owner`:
 * a run that fails (`run_failed`, with the reason the event carries), a gate nobody answered
 * within the wait (`run_awaiting_approval` / `step_awaiting_approval` with no
 * `step_approved` or run end before `approvalWaitMs`), and a budget threshold crossed
 * (`step_end` / `run_done` after which spent-over-limit reaches a percentage from
 * `budget.alert_thresholds`). Every condition sends exactly once: a failure once per run, a
 * reminder once per gate, a threshold once per process.
 *
 * Same shape as `RunApprovalLink`: a `BusHook` whoever iterates the run's events hands each one
 * to, with a flush that awaits the sends in flight. Timers are injected so a test can drive the
 * wait without waiting. With no owner configured nothing can be sent, so the hook is inert and
 * says so once, in a structured log line.
 */

import type { BusHook } from "../improve/trace-writer.js";
import type { OrcEvent } from "../orchestrator/types.js";
import { StructuredLogger } from "../telemetry/logger.js";
import type { GatewayManager } from "./GatewayManager.js";
import type { GatewayOwner } from "./RunApprovalLink.js";

/** The budget as the alert hook reads it: integer cents and percentage thresholds. */
export interface AlertBudgetPort {
  spentCents(): number;
  limitCents(): number;
  readonly thresholds: readonly number[];
}

/** `setTimeout` / `clearTimeout`, injectable so tests use fake time. */
export interface AlertTimers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface AlertHookDeps {
  readonly manager: Pick<GatewayManager, "send">;
  readonly owner?: GatewayOwner;
  readonly budget?: AlertBudgetPort;
  /** How long a gate may stay unanswered before one reminder goes out. */
  readonly approvalWaitMs: number;
  readonly timers?: AlertTimers;
  /** Where structured log lines go. Defaults to stderr. */
  readonly log?: (line: string) => void;
}

export interface AlertHook extends BusHook {
  /** False when no owner is configured: `sink` then does nothing. */
  readonly active: boolean;
  /** Disarms every pending reminder. Idempotent. */
  close(): void;
}

const GATE_KINDS: ReadonlySet<OrcEvent["kind"]> = new Set(["step_awaiting_approval", "run_awaiting_approval"]);
const RUN_END_KINDS: ReadonlySet<OrcEvent["kind"]> = new Set(["run_done", "run_failed", "run_cancelled"]);
const COST_KINDS: ReadonlySet<OrcEvent["kind"]> = new Set(["step_end", "run_done"]);

const CENTS_PER_UNIT = 100;

/** Integer cents as a currency-neutral decimal string; the only place cents become a display value. */
function formatCents(cents: number): string {
  const abs = Math.abs(Math.trunc(cents));
  return `${Math.floor(abs / CENTS_PER_UNIT)}.${String(abs % CENTS_PER_UNIT).padStart(2, "0")}`;
}

export function createAlertHook(deps: AlertHookDeps): AlertHook {
  const logger = new StructuredLogger({ runId: "gateway", stage: "gateway.alerts", sink: deps.log });
  const owner = deps.owner;
  if (owner === undefined) {
    logger.warn("gateway.alerts.disabled", { reason: "gateway.owner is not configured; failures, waiting approvals and budget alerts will not reach chat" });
    return { active: false, sink: () => undefined, flush: async () => undefined, close: () => undefined };
  }

  const timers: AlertTimers = deps.timers ?? { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout) };
  const pending = new Set<Promise<void>>();
  const failedRuns = new Set<string>();
  const announcedThresholds = new Set<number>();
  /** Armed reminder per gate key, so a gate reminds once and a decision disarms exactly it. */
  const reminders = new Map<string, unknown>();
  const keyOf = (runId: string, stepId: string): string => `${runId}/${stepId}`;
  let closed = false;

  const send = (text: string, fields: Record<string, unknown>): void => {
    const task = deps.manager
      .send(owner.platform, { channelId: owner.channelId, text })
      .then(() => logger.info("gateway.alerts.sent", fields))
      .catch((error: unknown) => logger.error("gateway.alerts.send_failed", { ...fields, reason: error instanceof Error ? error.message : String(error) }));
    pending.add(task);
    void task.finally(() => pending.delete(task));
  };

  const onFailed = (event: OrcEvent): void => {
    if (failedRuns.has(event.runId)) return;
    failedRuns.add(event.runId);
    const reason = event.detail ?? event.run?.summary ?? "no reason was reported on the bus";
    send(`Run ${event.runId} failed: ${reason}`, { kind: "run_failed", runId: event.runId });
  };

  const armReminder = (event: OrcEvent): void => {
    const stepId = event.step?.id;
    if (stepId === undefined) return;
    const key = keyOf(event.runId, stepId);
    if (reminders.has(key)) return;
    const title = event.step?.title ?? stepId;
    const minutes = Math.round(deps.approvalWaitMs / 60_000);
    const handle = timers.setTimeout(() => {
      reminders.delete(key);
      send(
        `Run ${event.runId} is still waiting for your approval of step ${stepId} (${title}) after ${minutes} minutes.`,
        { kind: "approval_reminder", runId: event.runId, stepId },
      );
    }, deps.approvalWaitMs);
    reminders.set(key, handle);
  };

  const disarm = (key: string): void => {
    const handle = reminders.get(key);
    if (handle === undefined) return;
    timers.clearTimeout(handle);
    reminders.delete(key);
  };

  const disarmRun = (runId: string): void => {
    for (const key of [...reminders.keys()]) if (key.startsWith(`${runId}/`)) disarm(key);
  };

  const checkBudget = (): void => {
    const budget = deps.budget;
    if (budget === undefined) return;
    const limit = budget.limitCents();
    if (limit <= 0) return;
    const spent = budget.spentCents();
    const percent = Math.floor((spent * 100) / limit);
    for (const threshold of [...budget.thresholds].sort((a, b) => a - b)) {
      if (percent < threshold || announcedThresholds.has(threshold)) continue;
      announcedThresholds.add(threshold);
      send(`Budget at ${threshold}%: ${formatCents(spent)} of ${formatCents(limit)} spent.`, { kind: "budget_threshold", threshold, spentCents: spent, limitCents: limit });
    }
  };

  return {
    active: true,
    sink(event) {
      if (closed) return;
      if (event.kind === "run_failed") onFailed(event);
      if (GATE_KINDS.has(event.kind)) armReminder(event);
      if (event.kind === "step_approved" && event.step?.id !== undefined) disarm(keyOf(event.runId, event.step.id));
      if (RUN_END_KINDS.has(event.kind)) disarmRun(event.runId);
      if (COST_KINDS.has(event.kind) && (event.kind === "run_done" || typeof event.step?.costCents === "number")) checkBudget();
    },
    async flush() {
      while (pending.size > 0) await Promise.all([...pending]);
    },
    close() {
      closed = true;
      for (const key of [...reminders.keys()]) disarm(key);
    },
  };
}
