/**
 * What `/context` knows, in one place, so the REPL and the TUI report the same numbers.
 *
 * Nothing here estimates anything. Every figure comes from the assembly the fleet-memory hook
 * actually performed for a seat call (`fleet-memory/tiers.ts`), which is the same object the seat's
 * prompt was built from: `chars` is the length of the text that was injected, and the three tier
 * sizes add up to it minus the separators between blocks. A surface that has never run a turn has
 * nothing to report and says so, rather than printing zeroes that look like measurements.
 *
 * `ContextTracker` exists because the hook is keyed by (run, seat) and only the surface knows which
 * pairs happened: it watches the event stream both surfaces already consume.
 */

import type { ContextInspector, ContextMeasurement, ContextRunSeats } from "./types.js";

/** The event fields the tracker reads. `OrcEvent` satisfies it structurally. */
export interface ContextTrackedEvent {
  readonly kind: string;
  readonly runId: string;
  readonly step?: { readonly agentRole?: string } | undefined;
}

/** The runs a session has started and the seats that ran in each, both oldest first. */
export class ContextTracker {
  readonly #runs = new Map<string, string[]>();

  observe(event: ContextTrackedEvent): void {
    if (event.runId === "") return;
    const seats = this.#runs.get(event.runId) ?? [];
    if (!this.#runs.has(event.runId)) this.#runs.set(event.runId, seats);
    const seat = event.step?.agentRole;
    // The seat a step ran on is the key the hook assembled that step's prompt under.
    if (seat !== undefined && seat !== "" && !seats.includes(seat)) seats.push(seat);
  }

  runs(): ContextRunSeats[] {
    return [...this.#runs].map(([runId, seats]) => ({ runId, seats: [...seats] }));
  }
}

/** One seat's measured injection, named. */
export interface ContextSeatReport extends ContextMeasurement {
  readonly runId: string;
  readonly seat: string;
}

export interface ContextReport {
  /** The newest run that assembled anything, newest seat last. Empty when no run has. */
  readonly seats: readonly ContextSeatReport[];
  readonly compactions: number;
}

export interface ContextReportInput {
  readonly inspector?: ContextInspector | undefined;
  readonly runs?: readonly ContextRunSeats[] | undefined;
  readonly compactions?: number | undefined;
}

/**
 * The newest run's measurements. Only the newest: a run the hook has already released returns
 * `undefined` from `contextFor`, and reporting an older run's numbers as if they were current is
 * exactly the kind of stale figure this command exists to replace.
 */
export function contextReport(input: ContextReportInput): ContextReport {
  const compactions = input.compactions ?? 0;
  const inspector = input.inspector;
  const runs = input.runs ?? [];
  if (inspector === undefined || runs.length === 0) return { seats: [], compactions };
  for (let index = runs.length - 1; index >= 0; index -= 1) {
    const run = runs[index]!;
    const seats: ContextSeatReport[] = [];
    for (const seat of run.seats) {
      const measured = inspector.contextFor(run.runId, seat);
      if (measured !== undefined) seats.push({ ...measured, runId: run.runId, seat });
    }
    if (seats.length > 0) return { seats, compactions };
  }
  return { seats: [], compactions };
}

/** The line a surface prints when nothing has been assembled yet. */
export const NO_CONTEXT_LINE = "No run has assembled a prompt in this session yet, so there is nothing to measure.";

function percent(ratio: number): number {
  return Math.round(ratio * 100);
}

/**
 * The report as plain lines, without a theme: the REPL paints them, the TUI puts them in a pane,
 * and both show the same figures in the same order.
 */
export function contextReportLines(report: ContextReport): string[] {
  if (report.seats.length === 0) return [NO_CONTEXT_LINE];
  const lines: string[] = [];
  for (const seat of report.seats) {
    lines.push(`run ${seat.runId}, seat ${seat.seat}`);
    lines.push(`  stable    ${seat.stableChars} chars`);
    lines.push(`  context   ${seat.contextChars} chars`);
    lines.push(`  volatile  ${seat.volatileChars} chars`);
    lines.push(`  injected  ${seat.chars} chars, ~${seat.estimatedTokens} tokens estimated`);
    lines.push(`  ceiling   ${seat.ceilingChars} chars, ${percent(seat.pressure)} percent used`);
    lines.push(`  dropped   ${seat.dropped.length === 0 ? "nothing" : seat.dropped.join(", ")}`);
    if (seat.overCeiling) {
      lines.push("  the stable tier alone is over the ceiling; nothing was dropped to make it fit");
    }
  }
  lines.push(`compactions this session: ${report.compactions}`);
  return lines;
}

/** One line for a status bar: the newest seat's size against the ceiling. */
export function contextStatusLine(report: ContextReport): string {
  const seat = report.seats.at(-1);
  if (seat === undefined) return NO_CONTEXT_LINE;
  return (
    `context ${seat.chars}/${seat.ceilingChars} chars (${percent(seat.pressure)} percent, ` +
    `~${seat.estimatedTokens} tokens) seat ${seat.seat}, compactions ${report.compactions}`
  );
}
