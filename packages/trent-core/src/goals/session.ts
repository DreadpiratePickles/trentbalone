/**
 * D4 — the goal session: the one object a surface needs, found the way the checkpoint session is.
 *
 * `file_ops` finds the checkpoint ledger on the process rather than through a context it is handed
 * (`checkpoints/session.ts`), for the same reason the REPL's `/goal` has to find the goal store on
 * the process: the runtime that owns the profile directory, the sandbox and the config is built in
 * one place (`apps/cli/src/runtime/headless.ts`) and the surfaces sit above it. One session at a
 * time, because one process serves one profile.
 */

import { goalsConfig, type GoalsConfig } from "./config-schema.js";
import { VerificationLedger } from "./evidence.js";
import type { GateBackend } from "./gates.js";
import { GoalStore } from "./store.js";

export interface GoalSessionOptions {
  readonly profileDir: string;
  readonly config?: Partial<GoalsConfig>;
  /** The sandbox gates run in. Absent, a goal with gates reports that it could not run them. */
  readonly backend?: GateBackend;
}

export class GoalSession {
  readonly store: GoalStore;
  readonly config: GoalsConfig;
  readonly evidence = new VerificationLedger();
  readonly backend: GateBackend | undefined;
  /** The goal the next run belongs to, set by `/goal` or `trent goal continue`. */
  #active: string | undefined;

  constructor(options: GoalSessionOptions) {
    this.store = new GoalStore(options.profileDir);
    this.config = goalsConfig(options.config);
    this.backend = options.backend;
  }

  get activeGoalId(): string | undefined {
    return this.#active;
  }

  /** Binds the next run to a goal, or unbinds when given nothing. An unknown id is refused. */
  bind(goalId: string | undefined): void {
    if (goalId !== undefined && this.store.get(goalId) === undefined) {
      this.#active = undefined;
      return;
    }
    this.#active = goalId;
  }

  /** Releases the gate sandbox. Idempotent, so every exit path may call it. */
  async cleanup(): Promise<void> {
    await this.backend?.cleanup?.();
  }
}

let active: GoalSession | undefined;

export function openGoalSession(options: GoalSessionOptions): GoalSession {
  active = new GoalSession(options);
  return active;
}

export function activeGoalSession(): GoalSession | undefined {
  return active;
}

/** Closes the session. With one given, closes only that one, so a replaced session survives. */
export function closeGoalSession(session?: GoalSession): void {
  if (session === undefined || active === session) active = undefined;
}
