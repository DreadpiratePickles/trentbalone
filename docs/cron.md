# Scheduled jobs: `trent cron`

```
npm run cli -- cron add --schedule "0 9 * * 1-5" --prompt "summarise yesterday's pipeline" --deliver slack:#sales
npm run cli -- cron list
npm run cli -- cron run <id>
npm run cli -- cron runs <id> --last 10
npm run cli -- cron start
npm run cli -- cron start --once
```

## One file, two writers

The schedule is `<profile>/cron/jobs.json`. The `cronjob_manage` tool (the `cron` toolset a seat
calls) and the `trent cron` group write the same record through the same helpers
(`packages/trent-core/src/tools/cron/index.ts`), so a job a seat creates in a conversation and a
job you add from the shell are the same row. Every write is temp-file-then-rename at mode 0600.

A schedule is a five-field cron expression (`minute hour day-of-month month day-of-week`, names
such as `mon-fri` and `jan,jul` allowed) or one of `@hourly`, `@daily`, `@midnight`, `@weekly`,
`@monthly`, `@yearly`. Times are UTC: `0 9 * * 1-5` is 09:00 UTC, and a daylight-saving change
never fires a slot twice or skips it. The prompt is scanned for injection and embedded credentials
on every write; a finding refuses the job and names its category, never the matched text.

## The runner

`trent cron start` is the scheduler. It builds the same headless runtime the REPL and the gateway
run on (`apps/cli/src/runtime/headless.ts`), takes `<profile>/cron/runner.lock` with its pid, and
ticks every 30 seconds (`packages/trent-core/src/cron/CronRunner.ts`). It holds the process until
Ctrl+C or SIGTERM; both release the lock, the gateway manager and the runtime. A second `start`
on the same profile exits 3 with "already running"; a lock left by a process that died is taken over.

`--once` ticks one time and exits, for an external scheduler (launchd, systemd timers, system cron)
that would rather own the interval.

On each tick, for every enabled job whose `next_run_at` has arrived (or that a seat marked with the
tool's `run` action), the runner FIRST rewrites jobs.json with `last_run_at` and the next slot, THEN
launches the prompt as one orchestrated run with `trigger: "scheduled"`. A process that dies between
the two loses that one run and never fires the same slot twice on restart. A job the runner sees for
the first time is anchored to its next slot rather than fired for a slot that passed while no runner
was up.

While no live runner holds the lock, every `cronjob_manage` summary ends with a note saying so, so a
seat never believes a job it created has already run. With a runner up, the note says the change
will be picked up on the next tick.

## Run history

Every run appends one line to `<profile>/cron/runs/<jobId>.jsonl`, capped at the newest 50:

```json
{"startedAt":"2026-09-15T09:00:00.000Z","endedAt":"2026-09-15T09:01:12.000Z","status":"completed","trigger":"scheduled","summary":"...","costCents":7}
```

`summary` is the run's own consolidated brief off the orchestrator's event stream (`consolidate_end`
/ `run_done`), exactly as the gateway's agent handler reads it; a failed run records
`Run failed: <reason>` from the `run_failed` frame. `costCents` is the sum of the steps' costs.
`trent cron runs <id> [--last N]` prints the rows; `--json` returns `{ id, runs }`.

`trent cron run <id>` runs a job now on the headless runtime, records a row with `trigger: "manual"`,
delivers the summary, and leaves the schedule fields alone. A failed run exits 5 with the recorded
reason. `--dry-run` reports `{ dryRun, command, id }` and runs nothing.

## Delivery

A job's `deliver` target is `<platform>:<channel>`: `slack:#sales`, `telegram:123456789`,
`discord:<channelId>`. The first colon splits, so an email address keeps its own. After a completed
run the runner hands the summary to `GatewayManager.send` for that platform, with the subject
`Trent cron: <job name>`; the manager persists it to the outbound queue first, so a platform that is
down gets the message on its next drain. A delivery that fails outright is recorded on the history
row as `deliveryError` and logged; the run still counts as completed and the summary is on disk.
The manager is built on first delivery only, so a job with no target never touches the gateway config.

## Logging

The runner logs through the structured logger (`packages/trent-core/src/telemetry/logger.ts`) to
stderr: job id, trigger, status, duration, cost, whether delivery happened. A prompt body never
reaches the log; the logger refuses payload fields by name rather than redacting them.
