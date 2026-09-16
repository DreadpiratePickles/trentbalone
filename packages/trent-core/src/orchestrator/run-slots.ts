/**
 * The per-orchestrator concurrent-run cap (`runtime.max_concurrent_runs`).
 *
 * A slot is taken before `launchOrchestration` and given back when the handle settles, so a run
 * that is waiting has no row, no `run_start` and no drain loop. The wait is FIFO: a slot freed by
 * one run goes to the oldest waiter, never back to the pool while anyone is waiting. A run parked
 * on an approval keeps its slot — a parked run is a run, and releasing its slot would let a cap of
 * one become two the moment a gate is raised.
 */

/** Default for `runtime.max_concurrent_runs`; the config schema carries the same value. */
export const DEFAULT_MAX_CONCURRENT_RUNS = 2;

export type ReleaseSlot = () => void;

export class RunSlots {
  readonly capacity: number;
  #busy = 0;
  readonly #waiting: Array<(release: ReleaseSlot) => void> = [];

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError(`max_concurrent_runs must be a positive integer, got ${String(capacity)}`);
    }
    this.capacity = capacity;
  }

  /** Runs holding a slot right now. */
  get busy(): number {
    return this.#busy;
  }

  /** Runs waiting for a slot. */
  get waiting(): number {
    return this.#waiting.length;
  }

  /**
   * Resolves with the release function once a slot is held. When none is free, `onQueued` is
   * called exactly once with how many runs are ahead of this one (holders plus earlier waiters).
   */
  acquire(onQueued?: (ahead: number) => void): Promise<ReleaseSlot> {
    if (this.#busy < this.capacity && this.#waiting.length === 0) {
      this.#busy += 1;
      return Promise.resolve(this.#releaser());
    }
    onQueued?.(this.#busy + this.#waiting.length);
    return new Promise<ReleaseSlot>((resolve) => this.#waiting.push(resolve));
  }

  /** Each release is honoured once: a double release must not free a slot someone else holds. */
  #releaser(): ReleaseSlot {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.#waiting.shift();
      if (next === undefined) {
        this.#busy -= 1;
        return;
      }
      // The slot changes hands without touching the pool, so FIFO order holds.
      next(this.#releaser());
    };
  }
}
