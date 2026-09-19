/**
 * D4 — the goal session the headless runtime opens (docs/goals.md).
 *
 * Its own file because `headless.ts` is at the repository's 500-line ceiling, and because this is
 * the same shape `wireCheckpoints`, `wireTelemetry` and `wireAlerts` have: read one config block,
 * build one collaborator, hand it back.
 */

import { openGoalSession, type GoalSession, type GoalsConfig } from "@trent/core/goals/index.js";
import { createSandbox } from "@trent/core/tools/sandbox.js";

/** The `goals` block the gates and `verify_on_stop` read; `TrentConfig` satisfies it structurally. */
export interface GoalsSlice {
  goals?: Partial<GoalsConfig>;
}

export interface GoalsWiringInput {
  readonly workspace: string;
  readonly profileDir: string;
  readonly backend: "docker" | "local";
  readonly image?: string;
}

/**
 * Opens this session's goal session: the goal store under the profile, the config block, the turn's
 * verification evidence, and the sandbox a quality gate runs in.
 *
 * It is opened in the graph every surface is built on, so `trent run`, the gateway, cron and the
 * heartbeat all get gates and `verify_on_stop` without wiring of their own — `/goal` and
 * `trent goal` look the session up on the process, exactly as `/rollback` looks up the checkpoint
 * ledger. The gate sandbox is the SAME one the `terminal` toolset uses and is built lazily, so a
 * session in which no gate ever runs starts no container.
 */
export function wireGoals(config: GoalsSlice, input: GoalsWiringInput): GoalSession {
  const sandbox = createSandbox({
    workspace: input.workspace,
    profileDir: input.profileDir,
    backend: input.backend,
    ...(input.image === undefined ? {} : { docker: { image: input.image } }),
  });
  return openGoalSession({
    profileDir: input.profileDir,
    backend: sandbox,
    ...(config.goals === undefined ? {} : { config: config.goals }),
  });
}
