# Scheduled jobs: `trent cron`

```
npm run cli -- cron add --schedule "0 9 * * 1-5" --prompt "summarise yesterday's pipeline" --deliver slack:#sales
npm run cli -- cron list
npm run cli -- cron run <id>
npm run cli -- cron runs <id> --last 10
npm run cli -- cron start
npm run cli -- cron start --once
npm run cli -- cron incidents
npm run cli -- cron incidents ack <id>
npm run cli -- cron queue list
npm run cli -- cron queue edit <id> --text "..."
npm run cli -- cron queue move <id> 2026-10-01T15:00:00Z
npm run cli -- cron queue rm <id>
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
Ctrl+C or SIGTERM; the command claims all three of SIGINT, SIGTERM and SIGHUP, releases the lock,
the gateway manager and the runtime, and only then exits 130. A second `start`
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

## Incidents

An unattended job that keeps failing must not keep messaging you, and must not keep spending. The
runner keeps an incident book at `<profile>/cron/incidents.json`
(`packages/trent-core/src/cron/incidents.ts`), separate from the schedule so the tool's rewrites
of jobs.json never touch a count:

- Per job, the count of consecutive **scheduled** failures. At `cron.failure_alert_after` (default
  3) the runner opens an incident and sends exactly one message to `gateway.owner` through the
  gateway manager's `send`, the path a heartbeat reply takes, starting with `[CRON_FAILURE]` and
  naming the job, the count and the last recorded reason. Every further failure is counted on the
  open incident and never alerted, until `trent cron incidents ack <id>` closes it and resets the
  count; the next streak of `failure_alert_after` alerts again. A completed run, scheduled or
  manual, ends the streak but leaves an open incident open: you have not seen it yet. A manual
  `trent cron run` failure is attended and does not count. Without `gateway.owner` the incident
  opens with `alerted: false` and the reason is on stderr.
- Profile-wide, the quota hold. A provider 429 on any run, scheduled or manual, sets
  `quota_hold_until`: the provider's own `Retry-After` when the gateway surfaced one, otherwise
  `cron.quota_hold_minutes` (default 30) from the failure. Until then a tick launches no
  prompt-driven job; a due job is neither stamped nor rescheduled, so it fires once the hold
  lifts, and `start --once` reports it under `held`. A handled job (a queued post, which calls no
  model) still runs. The hold is logged once, on the first tick that skips something, not once per
  tick.

`trent cron incidents` (or `incidents list`) prints the open incidents and the hold; `--json`
returns `{ incidents, quotaHoldUntil }`. `ack <id>` on a job with no open incident exits 3.
`--dry-run` on `ack` reports `{ dryRun, command, id }` and reads nothing.

## The post queue

A queued social post is a handled job on this same file (`handler: social_publish`, see
[social.md](social.md)): its payload carries the exact call a human approved and the preview they
saw, and at tick time the publish handler re-checks that call against the profile's approval rows
(`packages/trent-core/src/governance/bound-approvals.ts`). `trent cron queue` edits the queue
without cancelling and re-approving everything, and the approval rule follows from the binding
(`packages/trent-core/src/tools/cron/queue-edit.ts`):

- `queue list` shows queued posts only, with the time, the platform, the text and the state of
  the bound row (`approved`, `pending`, `denied`, `expired`, `none`); `--json` returns `{ posts }`.
- `queue edit <id> --text|--media|--account|--platform` changes what would leave the machine, so
  it is a different call. The rows bound to the old call are expired, the new post goes through
  the social toolset's own dry run (the same refusals `social_schedule` gives: no route for the
  platform, media on the Buffer path, a missing account id on a direct path), and a fresh pending row is parked for
  exactly the new content, with its id in the answer. A row is never reused, even for content that
  was approved once before. An edit that changes nothing writes nothing and the approval stands.
  A post that already published cannot be edited.
- `queue move <id> <when>` changes only when the post leaves (ISO 8601 with a zone, in the future,
  at most a year ahead). The call is unchanged, so its approval stands; the one-shot schedule and
  `next_run_at` are re-anchored the way queueing anchors them.
- `queue rm <id>` removes the job and deletes its pending row; an approved row is expired instead,
  so the same call queued again asks again. `trent cron remove` withdraws a plain scheduled job.

Every id subcommand under `--dry-run` reports `{ dryRun, command, id }` and touches nothing.

## Logging

The runner logs through the structured logger (`packages/trent-core/src/telemetry/logger.ts`) to
stderr: job id, trigger, status, duration, cost, whether delivery happened, and the hold a 429 set.
An incident that opens is an `error` line; the hold is one `warn` line. A prompt body never
reaches the log; the logger refuses payload fields by name rather than redacting them.
