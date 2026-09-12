import { describe, expect, it } from "vitest";
import {
  STABLE_RUN_STATUSES,
  TERMINAL_RUN_STATUSES,
  deriveRunStatusFromSteps,
  isPollTerminalRunStatus,
  reconcileRunStatus,
  terminalRunStatusFromEvents,
} from "@/lib/orchestrator-run-reconcile";

type StepLike = { status: string; output?: string; critique?: { verdict?: string } };

function event(kind: string, seq: number, payload: Record<string, unknown> = {}) {
  return { kind, seq, payload };
}

describe("reconcileRunStatus", () => {
  it("trusts an already-terminal persisted run (no reconciliation)", () => {
    const result = reconcileRunStatus({ persistedStatus: "completed", steps: [], events: [] });
    expect(result).toEqual({
      status: "completed",
      reconciled: false,
      reconciledFrom: "run",
      staleSnapshotDetected: false,
    });
  });

  it("trusts a persisted awaiting_approval run — never downgrades it to failed/lost", () => {
    const steps: StepLike[] = [
      { status: "completed", output: "done" },
      { status: "awaiting_approval", output: "pending gate" },
    ];
    const result = reconcileRunStatus({ persistedStatus: "awaiting_approval", steps, events: [] });
    expect(result.status).toBe("awaiting_approval");
    expect(result.reconciled).toBe(false);
    expect(result.reconciledFrom).toBe("run");
  });

  it("reconciles a stale planning run to completed when the trace has a terminal run_done event", () => {
    const events = [
      event("run_start", 1),
      event("step_end", 2),
      event("run_done", 3, { run: { status: "completed" } }),
    ];
    const result = reconcileRunStatus({ persistedStatus: "planning", steps: [{ status: "completed" }], events });
    expect(result.status).toBe("completed");
    expect(result.reconciled).toBe(true);
    expect(result.reconciledFrom).toBe("trace");
    expect(result.staleSnapshotDetected).toBe(true);
  });

  it("reconciles a stale running run to completed when every step is terminal-completed", () => {
    const steps: StepLike[] = [
      { status: "completed", output: "a" },
      { status: "completed", output: "b" },
    ];
    const result = reconcileRunStatus({ persistedStatus: "running", steps, events: [] });
    expect(result.status).toBe("completed");
    expect(result.reconciled).toBe(true);
    expect(result.reconciledFrom).toBe("steps");
    expect(result.staleSnapshotDetected).toBe(true);
  });

  it("reports failed honestly for a failed dependency cascade", () => {
    const steps: StepLike[] = [
      { status: "completed", output: "a" },
      { status: "failed", output: "provider exploded" },
      { status: "blocked", output: "Skipped — dependency s2 failed" },
    ];
    const result = reconcileRunStatus({ persistedStatus: "running", steps, events: [] });
    expect(result.status).toBe("failed");
    expect(result.reconciled).toBe(true);
    expect(result.reconciledFrom).toBe("steps");
  });

  it("reports awaiting_approval when a terminal step set still has a paused step", () => {
    const steps: StepLike[] = [
      { status: "completed", output: "a" },
      { status: "awaiting_approval", output: "needs founder sign-off" },
    ];
    const result = reconcileRunStatus({ persistedStatus: "running", steps, events: [] });
    expect(result.status).toBe("awaiting_approval");
    expect(result.reconciledFrom).toBe("steps");
  });

  it("surfaces awaiting_approval from a currently-paused step even when siblings are still pending", () => {
    const steps: StepLike[] = [
      { status: "completed", output: "a" },
      { status: "awaiting_approval", output: "needs founder sign-off" },
      { status: "pending" },
    ];
    const result = reconcileRunStatus({ persistedStatus: "running", steps, events: [] });
    expect(result.status).toBe("awaiting_approval");
    expect(result.reconciledFrom).toBe("steps");
  });

  it("ignores a STALE run_awaiting_approval event once the step has resumed (no re-pause)", () => {
    // The pause event is older history; the step was approved and is running again.
    const events = [
      event("run_awaiting_approval", 4, { run: { status: "awaiting_approval" } }),
      event("step_approved", 5, {}),
      event("step_start", 6, {}),
    ];
    const steps: StepLike[] = [
      { status: "completed", output: "a" },
      { status: "running" },
    ];
    const result = reconcileRunStatus({ persistedStatus: "running", steps, events });
    expect(result.status).toBe("running");
    expect(result.reconciled).toBe(false);
  });

  it("leaves a genuinely nonterminal run alone when there is no terminal trace and steps are still active", () => {
    const steps: StepLike[] = [
      { status: "completed", output: "a" },
      { status: "running" },
      { status: "pending" },
    ];
    const result = reconcileRunStatus({ persistedStatus: "planning", steps, events: [] });
    expect(result.status).toBe("planning");
    expect(result.reconciled).toBe(false);
    expect(result.staleSnapshotDetected).toBe(false);
  });

  it("does not invent a terminal state from an empty run", () => {
    const result = reconcileRunStatus({ persistedStatus: "planning", steps: [], events: [] });
    expect(result.status).toBe("planning");
    expect(result.reconciled).toBe(false);
  });
});

describe("terminalRunStatusFromEvents", () => {
  it("maps the latest terminal run event to a status", () => {
    const events = [
      event("run_failed", 2, {}),
      event("run_done", 5, {}),
    ];
    expect(terminalRunStatusFromEvents(events)).toBe("completed");
  });

  it("returns undefined when no terminal run event exists", () => {
    expect(terminalRunStatusFromEvents([event("step_end", 1)])).toBeUndefined();
  });
});

describe("deriveRunStatusFromSteps", () => {
  it("returns undefined when any step is still active", () => {
    expect(deriveRunStatusFromSteps([{ status: "completed" }, { status: "running" }])).toBeUndefined();
  });

  it("returns completed when all steps are completed", () => {
    expect(deriveRunStatusFromSteps([{ status: "completed" }, { status: "completed" }])).toBe("completed");
  });
});

describe("status sets and poll helper", () => {
  it("treats awaiting_approval as a stable (paused) state but not terminal", () => {
    expect(STABLE_RUN_STATUSES.has("awaiting_approval")).toBe(true);
    expect(TERMINAL_RUN_STATUSES.has("awaiting_approval")).toBe(false);
  });

  it("isPollTerminalRunStatus stops polling on terminal and paused states only", () => {
    expect(isPollTerminalRunStatus("completed")).toBe(true);
    expect(isPollTerminalRunStatus("failed")).toBe(true);
    expect(isPollTerminalRunStatus("cancelled")).toBe(true);
    expect(isPollTerminalRunStatus("awaiting_approval")).toBe(true);
    expect(isPollTerminalRunStatus("planning")).toBe(false);
    expect(isPollTerminalRunStatus("running")).toBe(false);
  });
});
