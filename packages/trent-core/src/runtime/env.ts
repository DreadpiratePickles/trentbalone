/**
 * The standalone environment contract.
 *
 * A compiled Trent binary does not run under vitest, so it does not inherit the `NODE_ENV=test`
 * escape hatch that suppresses the queue's inline fallback processor (`apps/web/lib/queue.ts:189`).
 * Left at its default, that fallback fires each job through `setTimeout` while the CLI is also
 * draining the queue explicitly, so **every job executes twice**.
 *
 * Measured on a three-step run: 31 worker invocations, 13 step executions, `run_done` emitted ten
 * times, zero bytes on stderr, and a final status of `completed`. The overspend is invisible.
 *
 * Every entry point that drives an orchestration must call `applyStandaloneEnv` before importing any
 * module from `apps/web/lib`, then `assertStandaloneEnv` to fail loudly if something later mutated it.
 */

/** Sentinel meaning "keep orchestration state in-process"; selects the in-memory store. */
export const IN_MEMORY_DATABASE = ":memory:" as const;

export type StandaloneEnv = {
  /** Must be "disabled". Anything else double-executes every job. */
  TRENT_QUEUE_FALLBACK: "disabled";
  /** Must be "1": a promoted skill reaches the seat that earned it (`orchestrator-runtime.ts:1437`). */
  SKILL_INJECTION_ENABLED: "1";
  /** Must be empty so `getQueue()` returns null and no BullMQ connection is attempted. */
  REDIS_URL: "";
  /** A SQLite URL for durable mode, or absent when using the in-memory store. */
  DATABASE_URL?: string;
};

/** Redis variables that would otherwise pull the run onto a real queue. */
const REDIS_KEYS = ["REDIS_URL", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"] as const;

/**
 * Seed `process.env` for a standalone run.
 *
 * Call this BEFORE the first `import` of any `apps/web/lib` module: `ai-client.ts` freezes its model
 * registry and token limits at module-evaluation time, so a later write is ignored.
 *
 * @param databaseUrl A SQLite connection string, or {@link IN_MEMORY_DATABASE} to use the in-process
 *   store. The in-memory case deliberately leaves `DATABASE_URL` unset, because `store.ts:11` selects
 *   the Prisma store whenever that variable is present.
 */
export function applyStandaloneEnv(databaseUrl: string): void {
  // The single line that prevents duplicate execution.
  process.env.TRENT_QUEUE_FALLBACK = "disabled";

  // Fire-and-forget synchronous dispatch would also double-run against an explicit drain.
  delete process.env.TRENT_EVAL_SYNC_QUEUE;

  for (const key of REDIS_KEYS) delete process.env[key];
  process.env.REDIS_URL = "";

  // The loop's output reaches a seat only with this on (`orchestrator-runtime.ts:53` reads it at
  // module evaluation, hence the "call before any apps/web import" rule above). Off, every promoted
  // skill is context the seat lacks: L8's "low-context human" finding, and appliedRate stays 0.
  process.env.SKILL_INJECTION_ENABLED = "1";

  if (databaseUrl === IN_MEMORY_DATABASE) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = databaseUrl;
}

/**
 * Throw if the current environment would produce duplicate or non-deterministic execution.
 * Never includes an environment value in the message — only variable names.
 */
export function assertStandaloneEnv(): void {
  const violations: string[] = [];

  if (process.env.TRENT_QUEUE_FALLBACK !== "disabled") {
    violations.push(
      "TRENT_QUEUE_FALLBACK must be \"disabled\"; otherwise the inline fallback races the drain loop and every job executes twice",
    );
  }
  if (process.env.TRENT_EVAL_SYNC_QUEUE) {
    violations.push("TRENT_EVAL_SYNC_QUEUE must be unset; it dispatches jobs fire-and-forget");
  }
  for (const key of REDIS_KEYS) {
    if (process.env[key]) violations.push(`${key} must be unset in standalone mode`);
  }

  if (violations.length > 0) {
    throw new Error(`Unsafe standalone environment:\n  - ${violations.join("\n  - ")}`);
  }
}

/** The variables a standalone run relies on, for `trent doctor` to display. Values are never read. */
export function standaloneEnvKeys(): readonly string[] {
  return ["TRENT_QUEUE_FALLBACK", "TRENT_EVAL_SYNC_QUEUE", ...REDIS_KEYS, "DATABASE_URL", "SKILL_INJECTION_ENABLED"] as const;
}
