/**
 * Actuals Provider — the seam between the frozen eval suite and the thing that
 * produced the agent's outputs.
 *
 * autoresearch's loop only means something when a candidate (new SKILL.md or
 * evolved prompt) is actually RUN to produce fresh outputs ("actuals") that the
 * eval suite then scores. That live execution is costly (orchestrator calls +
 * budget), so Slice 1 stops at REPLAYED actuals: deterministic, recorded outputs
 * that make the whole loop unit-testable at zero spend.
 *
 * The interface is the extension point: the live-execution slice swaps in a
 * provider that runs the orchestrator under the candidate, while everything
 * downstream (frozen suite → eval gate → promotion) stays unchanged.
 */

/** A single fixture's recorded/observed agent output, in eval-harness shape. */
export type FixtureActual = {
  text?: string;
  toolCalls?: string[];
  state?: Record<string, unknown>;
};

/** Resolves the actual output for a given fixture id. */
export interface ActualsProvider {
  get(fixtureId: string): FixtureActual | undefined;
}

/**
 * Deterministic, zero-spend provider backed by a recorded map of
 * fixtureId → actual. Used for Slice 1 plumbing and for tests.
 */
export class RecordedActualsProvider implements ActualsProvider {
  constructor(private readonly records: Readonly<Record<string, FixtureActual>>) {}

  get(fixtureId: string): FixtureActual | undefined {
    return this.records[fixtureId];
  }
}
