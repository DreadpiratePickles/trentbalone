# Jobs: the concurrent-run cap and the failed-jobs view

Every run a surface starts (REPL, TUI, gateway, cron, heartbeat, `trent jobs retry`) goes through
`createOrchestrator()` in `packages/trent-core/src/orchestrator/`, which owns the drain loop that
advances the app's queued orchestration jobs. This page covers the two controls around it:
how many runs are driven at once, and what to do with a job that failed.

## `runtime.max_concurrent_runs`

```yaml
runtime:
  max_concurrent_runs: 2      # integer, at least 1; default 2
```

The cap is per profile: the headless runtime reads it from config and hands it to the orchestrator
(`apps/cli/src/runtime/headless.ts`), so every surface built on that runtime shares one pool of
slots (`packages/trent-core/src/orchestrator/run-slots.ts`).

What a run past the cap does:

- It is not launched. `run()` takes a slot before `launchOrchestration`, so a waiting run has no
  row in the store, no `run_start` and no drain loop. `handle.started` resolves only once it has
  a slot and a run id.
- It waits in FIFO order. A slot freed by one run goes to the oldest waiter, never back to the
  pool while anyone is waiting.
- It says so once. The handle's event stream (and the trace sink) gets one `heartbeat` frame with
  `runId: ""` and `detail: "queued: N ahead; max_concurrent_runs is <cap>"`, where N counts the
  runs holding a slot plus the earlier waiters. The bus hooks (improve loop, telemetry, alerts)
  do not see this frame: the run has no id yet and they key their state by run.
- Cancelling or aborting it while it waits ends it as soon as a slot arrives, without a launch;
  `cancel()` returns `true` for a run that never launched.

A run parked on an approval keeps its slot. A parked run is a run: releasing its slot would let a
cap of one become two the moment a gate is raised, and the approval reminder in `gateway.alerts`
exists so a parked run is answered, not queued behind.

## `trent jobs failed [--last N]`

Lists the failed `JobRun` rows of this profile's store, newest first, with `id`, `type`,
`trigger`, `finishedAt`, `error` and `summary`. `--last` defaults to 20. The rows are what the
app's queue writes: an `orchestration_step` row per plan, step and consolidate job, with the
worker's error message when it failed.

```
$ trent jobs failed --last 5
FAILED JOBS (1)
  job_qtx7msxy83q0           2026-09-15T09:01:00.000Z orchestration_step system
    provider returned 429
```

`--json` emits `{ count, durable, jobs: [...] }`. `durable: false` means the store under this
runtime is the in-process fallback (bun:sqlite unavailable), which keeps no rows between
processes, so an empty list there is not evidence that nothing failed.

The command opens the same headless runtime the other surfaces use, because the store lists job
rows per company and the company id is only known to that graph. `--dry-run` reports what it would
list without building it.

## `trent jobs retry <id> [--objective <text>]`

Runs the failed job's objective again as a new manual run through the headless runtime, waits for
it to end, and reports `{ retryOf, objective, runId, status, summary, link }`. The exit code is 0
when the new run completed and 5 (provider) when it failed or was cancelled, so a script can tell.

Where the objective comes from: the job row's run link (`metadata.runId`) is read when the store
returns it, and the run's objective is reused verbatim. The core store's `JobRunRecord`
(`packages/trent-core/src/store/StorePort.ts`) does not carry `metadata`, so with today's SQLite
store the link is absent; in that case the command refuses with exit code 3 and asks for
`--objective <text>`, which is then what runs.

How the link is recorded: a new row of type `orchestration_retry`, trigger `manual`, whose
payload (`metadata`) is `{ retryOf: <job id>, runId: <new run id> }` and whose summary reads
`retry of <job id> as run <run id>`. The payload is stored by the durable store; the in-process
fallback drops it and keeps the summary. `link` in the output is that row's id.
