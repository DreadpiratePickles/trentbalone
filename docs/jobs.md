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

## Resuming a run a killed process left behind

`trent run --resume <runId>` (and `orchestrator.resume(runId)` for any surface built on the
orchestrator) picks up a run whose process died mid-step: a `trent run` that was killed, a cron
tick or a heartbeat sweep that never finished. The app persists every step and its job rows; the
wrapper's drain loop used to drain only the run it had launched, so those rows sat `running`
forever. Resume rebuilds the run through the app's `hydrateOrchestrationRun`, then enqueues
exactly what the dead process owed (`packages/trent-core/src/orchestrator/resume.ts`): the job
rows it left `running` are drained as they are; with none, the ready steps
(`selectReadyStepsForEnqueue`) or, failing those, the steps left `running`; a run with no plan is
planned; a run with every step settled is consolidated; a finished run is reported as it is, and
an unknown id is a configuration error naming the id. The stream starts with the run's own
`run_start` and one `heartbeat` line saying what resume decided; the exit codes are `trent run`'s.

A replayed step cannot repeat a side effect. Its tool calls are keyed by `{runId, stepId, tool,
args}` in the durable idempotency store under the profile (`governance/idempotent-dispatch.ts`),
and the vocabulary covers write, patch, execute, send, publish, post, reply, book, invoice, charge,
pay, sms, refund and email (gate G3), so the second execution of the same call in the same step is
answered from the store instead of being made again. `orchestrator/orchestrator.resume.test.ts`
kills a two-step run after its `write_file` completed, deletes the file, resumes in a fresh
orchestrator, and shows step two ran once, the run ended `completed`, and the file was not
rewritten.

## Auto-recovery cycles

A run used to die on one flaky call: the gateway retries a 429, a 5xx, a 408 or a dropped socket
a bounded number of times per call (`model-gateway/retry.ts`), and when those attempts were spent
the step failed and the run went on without it. `agent.auto_recovery_cycles` (default 1; 0 turns
it off) is the layer above that: a step that failed on a TRANSIENT provider or tool error is run
again, once per cycle, with the previous error appended to its prompt as a plain sentence, and
then it stops (`packages/trent-core/src/orchestrator/auto-recovery.ts`).

What counts as transient is the gateway's own classification, read from the error object when
the seat port threw one and from its message otherwise, because the app's seat executor keeps
only `error.message`: HTTP 429, 408 and 5xx, the transport codes (`ECONNRESET`, `ETIMEDOUT` and
the rest), and undici's `fetch failed`. A tool result opts in by starting its summary with
`[transient]`. What is never re-run: an approval park (it is a question, not a failure), a budget
stop (the wrapper ended that seat on purpose), a dependency skip, a hardline refusal or a gated
result (neither classifies as transient), and any other non-transient error such as a 401 or a
missing key.

How a cycle works: the app emits the failed `step_end` before it schedules what follows, and the
bus delivers it synchronously, so the wrapper resets the step to `pending` inside that event and
writes the row; the app's own scheduler then re-enqueues the step. The step's earlier tool calls
are keyed by `{runId, stepId, tool, args}` in the idempotency store, so a write or a send the
failed cycle already made is answered from the store on the re-run, not repeated, exactly as a
resume's replay is. Every cycle is one `step_note` on the run
(`auto recovery cycle 1 of 1 for step s1 (...): re-running after a transient dependency error: ...`),
a surface can show it, and the failed cycle's spend is carried onto the step that finally
completes (the app drops a cycle's cost when the seat loop throws; the wrapper's port metered it).
A step that exhausts its cycles ends `failed` with every error it saw, in order, and the run ends
`failed` naming the step and those errors; the stream's `run_done` becomes `run_failed`.
`orchestrator/orchestrator.recovery.test.ts` proves the recovered write is not repeated, the
second failure is reported with both errors, and a park is left alone.

## A cron job's model pin

| Flag | Stored as | At fire time |
|---|---|---|
| `trent cron add --model <id>` | `model` on the job in `<profile>/cron/jobs.json` (listed by `trent cron list`) | The whole run (planner, critic, consolidator and every seat) runs on the pin, and the history row records it as `model` (`trent cron runs <id>`); a job without one runs on the models configured when it fires. |

A pinned job runs in its own process: the runner starts `trent run - --model <id> --format
stream-json` on the same profile, hands it the prompt on stdin, and folds the child's events into
the job's history row exactly as it folds an in-process run, so the summary, the cost, the delivery
and the incident book are unchanged. It is a process of its own because a runtime is on one model
for its life: the app resolves every model name from the environment and freezes some of them when
it loads. The child's spend is charged to `cron`, and a run that ends any way but `completed`
records a failed row with the child's own reason. The pin must be one model id of the profile's
provider; `models.fallback_on_pin` decides whether a pinned call may fall back to another provider
(by default it may not). The same pin is available to a one-off run as `trent run --model <id>`.

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
