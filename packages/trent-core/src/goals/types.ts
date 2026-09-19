/**
 * D4 — the shapes a goal is made of.
 *
 * A gate is an ARGV, never a command line. That is the whole safety property of this module: the
 * executable and its arguments come from the user's config or from `--gate` on the command line,
 * the sandbox is handed each element quoted, and no string a model produced is ever spliced into
 * a shell. A goal whose gate could be written by the agent it judges would be no gate at all.
 */

/** One deterministic quality gate: an executable plus its arguments, and where it runs. */
export interface GoalGate {
  readonly name: string;
  /** argv[0] is the executable. Quoted element by element; never parsed as a shell string. */
  readonly command: readonly string[];
  /** Working directory as the sandbox sees it; the workspace root when absent. */
  readonly cwd?: string;
  readonly timeout_ms?: number;
}

/**
 * `open` — the goal is being worked on. `gated` — its last run failed a gate and a continuation is
 * owed. `completed` — every gate was green and the judge said the contract was met. `abandoned` —
 * a human closed it.
 */
export type GoalStatus = "open" | "gated" | "completed" | "abandoned";

/** How one run of a goal ended, as the goal's own history records it. */
export interface GoalRunRecord {
  readonly run_id: string;
  readonly at: string;
  readonly outcome: "gated" | "unverified" | "completed";
  /** The gate that went red, when one did. */
  readonly gate?: string;
  readonly exit_code?: number;
  /** The bounded tail of the red gate's output: this is the next run's continuation prompt. */
  readonly tail?: string;
}

/** A standing objective that outlives one run, with a contract and the gates that check it. */
export interface GoalRecord {
  readonly id: string;
  readonly objective: string;
  /** The completion contract in the user's own words: what "done" means for this goal. */
  readonly contract: string;
  readonly gates: readonly GoalGate[];
  readonly status: GoalStatus;
  readonly created_at: string;
  readonly runs: readonly GoalRunRecord[];
  /** How many continuations have been STARTED. Bounded by `goals.max_continuations`. */
  readonly continuations: number;
}

/** What one gate did. `tail` is bounded: a gate that printed a megabyte cannot become a prompt. */
export interface GateResult {
  readonly name: string;
  readonly command: readonly string[];
  readonly exitCode: number;
  readonly tail: string;
  readonly durationMs: number;
}

/** A prompt-shaped message, structurally identical to the orchestrator's `ConversationMessage`. */
export interface GoalMessage {
  readonly role: "user" | "assistant" | "system";
  readonly content: string;
}

/** The next run of a gated goal: the same objective, with the red gates' reports as history. */
export interface GoalContinuation {
  readonly goalId: string;
  /** 1 for the first continuation. Refused once it would exceed `goals.max_continuations`. */
  readonly attempt: number;
  readonly objective: string;
  readonly history: readonly GoalMessage[];
}

/** An id that would leave `<profileDir>/goals/`, or a `--gate` the parser cannot read. */
export class GoalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoalError";
  }
}

/**
 * 4 kB of gate output. It has to be small enough to ride in a prompt every continuation carries
 * and large enough to hold a compiler's error list; the head and the tail are both kept, because a
 * test runner's verdict is at the end and a compiler's first error is at the start.
 */
export const GATE_TAIL_MAX_CHARS = 4_000;

export const GOALS_DIR_MODE = 0o700;
export const GOALS_FILE_MODE = 0o600;

/** Default continuation bound. Three attempts at a red gate is the point at which a human is owed one. */
export const DEFAULT_MAX_CONTINUATIONS = 3;

/**
 * The commands that count as fresh evidence for `verify_on_stop`, matched on the executable and
 * the first argument only. `npm test` matches `npm test -- -t parser`; `npm run build` matches
 * nothing here, because building is not verifying.
 */
export const DEFAULT_VERIFY_COMMANDS: readonly string[] = [
  "npm test",
  "npm run typecheck",
  "npx vitest",
  "npx tsc",
  "pytest",
  "go test",
  "cargo test",
];
