# 2026-09-26 — env-guard flake: the "without the contract" guard in `runtime/env.test.ts`

The defect: CI run 36229183545 (8f3c70b) failed 1 of 4982 tests,
`packages/trent-core/src/runtime/env.test.ts > standalone environment contract > guard: without the
contract a compiled binary double-executes, silently`, `AssertionError: expected 1 to be greater than 1`
at `env.test.ts:125` (`expect(result.runDoneCount).toBeGreaterThan(1)`). Same test green on 5434b9d,
d711691, b1fcef5.

Owned: `packages/trent-core/src/runtime/env.test.ts` (and a helper beside it if needed), this log.
No production code, no AGENTS.md edit (report instead), no commit, stash, checkout, reset or push.
No subagents (the brief says so). Single test file at a time.

## Read first
AGENTS.md "The standalone environment contract", rulebook Phase 4, `env.test.ts`, `runtime/env.ts`,
`apps/web/lib/queue.ts` (`runFallbackJob`, `processJobData`, `addBullJobOrMarkFailed`,
`enqueueExistingJobRunForProcessing`), `orchestrator-run-queue.ts`, `orchestrator-run-worker.ts`,
`orchestrator-run-phases.ts` (`processPlanPhase`, `processExecuteStepPhase`, `processConsolidatePhase`),
`job-events.ts`, `mem-store-docs.ts` (events, job runs), `packages/trent-core/src/orchestrator/drain.ts`.

## How the double execution actually happens (read, then measured)
- `enqueueExistingJobRunForProcessing` -> `addBullJobOrMarkFailed` -> no Redis -> `runFallbackJob`, which
  (NODE_ENV=production, no `TRENT_QUEUE_FALLBACK`) schedules `setTimeout(processJobData, 0)` for EVERY
  enqueued job, then emits a `queued` job event. The fallback never checks the job's status
  (`processJobData` only skips a `cancelled` job), so the fallback runs every job exactly once.
- The drain (the test's loop, a port of `orchestrator/drain.ts`) runs a job only if its record is still
  `running` when it lists. A record is marked `completed` by whichever execution finishes first. So a
  job runs twice only when the drain reaches it before the fallback finishes it; the drain can also
  EXIT while fallback executions of already-completed records are still in flight, and those carry the
  tail of the run alone.
- `processConsolidatePhase` has no idempotency guard, so `run_done` count == number of consolidate
  EXECUTIONS. That is interleaving-dependent: it can be 1 even though other jobs ran twice.
- The plan job is always executed twice: `launchOrchestration` returns and the drain's first list and
  `processJobData` call happen in microtasks, before the fallback's timer can fire, so the drain always
  takes the plan job; the fallback then runs it again unconditionally. `processPlanPhase` has no
  guard either, so `plan_start` is 2 in every no-contract run.

## Evidence: the CI failure was an ABSENT second run_done, not a late one
CI job 108369276386 log (`gh run view --job 108369276386 --log`), guard test stdout:
13 `[Queue Fallback] Enqueuing` lines (13 job records), 19 `[Worker] Starting job` lines: 6 job ids
started twice (drain + fallback), 7 started once (fallback only, after the drain had exited). All of
it between 08:20:20.381 and 08:20:20.487 (~106 ms). The next line from this file is the contract
test's first job at 08:20:22.989, i.e. the guard's fixed 2.5 s settle elapsed with NO further job
starting. So at the assertion the run had been idle ~2.5 s and `run_done` was 1 for good. Waiting
longer would not have helped. The premise "run_done > 1" is wrong; the premise "jobs execute more
than once" held (19 executions for 13 records).

## Local probe (temporary `describe.runIf(ENV_PROBE)` block, removed)
Counts after the drain exits, then polled until 3 s without change (max 30 s):
- eager drain (the test's loop), 5 runs idle machine + 6 runs under 16 busy loops + `nice -n 19`:
  run_done at drain exit 4-7, final 8-14, plan_start 2 every run, started == drainCalls + queued
  every run (the fallback runs every enqueued job once).
- drain that yields between jobs (setImmediate / 0 / 2 / 10 ms), 12 runs: 3 runs ended with
  `final run_done = 1` after 30 s-bounded quiescence (e.g. 13 jobs, 18 executions, plan_start 2,
  consolidate_start 1) - the exact CI shape. plan_start 2 and max executions per job 2 in all 12.

## Log
- RED (original guard, one temporary line: the harness drain awaits `setImmediate` after each job,
  the shape CI hit): `npx vitest run packages/trent-core/src/runtime/env.test.ts -t guard`, 10 runs:
  exit 0 x9, exit 1 x1 (run 9): `AssertionError: expected 1 to be greater than 1` at
  `env.test.ts:126:33`. That run's stdout: 13 enqueues, 19 starts, 6 job ids started twice, 7 once -
  the CI log's numbers exactly. "Return early" (drop the 2.5 s settle) does NOT reproduce it with the
  eager drain: run_done is already 4-7 at drain exit there. Lateness is not the mechanism.
- Fix design: the guard waits (bounded, 45 s of the 60 s budget) until the fallback is drained -
  every enqueued job's fallback execution has started and finished (job-event bus: `started` ==
  drain calls + `queued`, terminal == `started`) - then asserts on the settled record: some job record
  executed more than once, and some billed phase (plan / step / consolidate / run_done in the run's
  event ledger) began more than once. `run_done > 1` is dropped as the evidence (it is 1 in the CI
  shape). The contract test asserts the mirror: every phase once, every job record executed once,
  run_done 1, so the guard keeps it non-vacuous. A second guard case runs the yielding drain.
- Implemented in `env.test.ts` only (no helper file needed, 253 lines). `runOnceOffline(label,
  { drain: "eager" | "yielding", settle: "fallback-drained" | "quiet-window" })` subscribes to the
  app's job-event bus (`subscribeJobEvents`, filtered to this company's `orchestration_step` jobs),
  counts `queued` / `started` / terminal events, and reads phase starts from the run's event ledger.
  Settle deadline is 45 s from the start of the run (cold imports took 14 s under load), so a stuck
  settle ends in an assertion with the settled record in the message, not a vitest timeout.
  Guards (eager, and a new yielding case): status `completed`, >= 1 job record executed twice,
  executions > job records, >= 1 billed phase started twice. Contract test: run_done 1, idle, no
  repeated job, executions == job records, every phase (plan, each step, consolidate, run_done) once.
- Debug check (temporary stderr line, removed): settled records e.g. guard `jobs 13, executions 21,
  plan 2, consolidate 2`; contract `jobs 5, executions 5`, every phase 1.
- GREEN under the red condition: yielding guard, 15 runs, exit 0 x15. Run 8 was the CI shape exactly:
  `jobs 13, executions 19, plan 2, consolidate 1, run_done 1, 6 repeated jobs, idle true` - the old
  assertion fails that run, the new one passes it.
- Mutation check: contract test with `applyStandaloneEnv`/`assertStandaloneEnv` removed -> exit 1,
  `AssertionError: expected 6 to be 1` (run_done). Restored; `cmp` against the saved final copy: identical.
- Final file, `npx vitest run packages/trent-core/src/runtime/env.test.ts`, 5 in a row: exit 0, 0, 0,
  0, 0 (5 passed each). Under load (16 busy loops + `nice -n 19`, load avg 52 -> 84): exit 0, 5 passed,
  9.16 s. An earlier loaded run (pre deadline tweak): exit 0, guard 14.1 s.
- `npx tsc --noEmit -p packages/trent-core/tsconfig.json`: exit 0, 0 errors.

## Report (not edited, per the brief)
- The guard's premise as measured was wrong: the double `run_done` does not always happen. It is
  absent (not late) whenever the fallback alone runs the only consolidate job (CI 36229183545; 3 of 12
  and 1 of 15 local yielding-drain runs). Double EXECUTION always happens (the plan job every time).
- AGENTS.md:30 "every job runs twice" and `runtime/env.ts` docstring "every job executes twice" /
  `assertStandaloneEnv`'s message "every job executes twice" overstate it. Accurate: the fallback runs
  every enqueued job once and the CLI's drain runs every job it reaches while still `running`, so jobs
  run more than once (CI: 19 executions of 13 job records; locally 16-33 executions of 11-20) and
  the duplicates cascade into more jobs; the run still reports `completed`. Suggested wording for
  AGENTS.md:30: "Without the first line, jobs execute more than once (the app's in-process fallback
  re-runs every enqueued job beside the CLI's drain) and the run still reports success".
- Production code untouched; the contract itself is not broken (mutation check above).
