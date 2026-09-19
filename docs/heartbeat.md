# The heartbeat: `trent heartbeat`

```
npm run cli -- heartbeat start
npm run cli -- heartbeat start --once
npm run cli -- heartbeat status
npm run cli -- heartbeat runs --last 10
```

The heartbeat is the founder's periodic check. Every `heartbeat.interval_minutes` (default 60),
outside quiet hours, Trent runs one orchestrated turn over `<profile>/HEARTBEAT.md` plus a block
of live fleet state, with `trigger: "heartbeat"`. If the turn's consolidated summary is exactly
`NO_REPLY`, nothing is sent. Anything else is delivered to `gateway.owner` as a message. There is
no rule table deciding what matters: the checklist is the founder's, in plain markdown, and the
model reads it against the state block on every tick.

## `HEARTBEAT.md`

Setup writes a default checklist into the profile once (`packages/trent-core/src/heartbeat/checklist.ts`)
and never rewrites it; edit it freely. The default lists approvals waiting on the founder, budget
above 80 percent of the cap, runs that failed since the last heartbeat, scheduled jobs whose last
run failed, and company memory not updated for 7 days. A profile with no file at all gets the same
default text as the objective.

## The objective

Each tick's objective is, in order:

1. the checklist text;
2. a `## Fleet state` block (`heartbeat/fleet-state.ts`): pending approvals from
   `<profile>/gateway.json`, a budget line when a budget port is wired, the newest row of every
   job under `<profile>/cron/runs/*.jsonl`, and the previous heartbeat's outcome;
3. the contract sentence: "If nothing on this checklist needs the founder, answer exactly NO_REPLY."

A state file that is missing or unreadable is reported as such inside the block; it never fails
the tick.

## Quiet hours

`heartbeat.active_hours { start, end, tz }` is the founder's waking window on the wall clock of
`tz` (an IANA zone, default UTC). `start` and `end` are `HH:MM`; the end is exclusive; a window
that crosses midnight (`22:00` to `06:00`) wraps. Outside the window the tick makes no model call
and records a `quiet` row. No `active_hours` means never quiet. The semantics are those of
`apps/web/lib/supervision/quiet-hours.ts`, reimplemented in `heartbeat/quiet-hours.ts` with a zone
and minute resolution.

## Memory consolidation

With `heartbeat.consolidate_memory: true` (the default) the loop calls the sleep-time memory
consolidation (`fleet-memory/consolidate.ts`) once per local calendar day, at the first quiet
tick; with no `active_hours` it runs at the first tick of each day. The CLI binds it to the
runtime's store and the configured provider, built on first use. The row of the tick that ran it
carries `consolidated: true`, and a fresh loop over the same profile reads that back so a restart
never runs it twice in one day. The pass covers every block `memory.blocks` configures, each under
its own limit, and leaves `read_only` blocks alone. Consolidation only drafts; promotion stays a
human step (`trent improve promote`).

## Delivery

A reply goes through the gateway manager's `send` to `gateway.owner` with the subject
`Trent heartbeat`. The manager is built on the first delivery, so a heartbeat that answers
`NO_REPLY` all day never touches the gateway. With no owner configured the row records
`deliveryError` naming `gateway.owner`, and keeps the reply text on disk so `trent heartbeat runs`
can show what would have been sent.

`trent gateway start` also starts the loop when `heartbeat.enabled` is true, on the same runtime
and the same manager the listeners use; its JSON output reports `heartbeat: true`.

## History and the lock

Every tick appends one row to `<profile>/heartbeat/runs.jsonl` (mode 0600, newest last, capped at
200): `{ at, decision }` plus `chars` for a reply, `costCents` when the run reported cost, `reason`
for a failed run, `deliveryError` and `text` when a reply could not be sent, and `consolidated`
when memory consolidation ran. Decisions are `quiet`, `no_reply`, `reply` and `failed`.

`start` takes `<profile>/heartbeat/runner.lock` with its pid and refuses (exit 3, "already
running") while another live process holds it; a lock left by a dead pid is taken over. The command
claims Ctrl+C as well as SIGTERM and SIGHUP: each releases the lock, the manager and the runtime,
and the process exits 130 only once that release has settled. `--once` ticks one time and
exits, for launchd, systemd timers or system cron.

`status` reports `enabled`, `intervalMinutes`, `activeHours`, `quietNow`, `running`, the last row
and `nextTickAt` (the last row plus the interval; `null` before the first tick).

## Logging

The structured log carries the decision, the duration, the cost and a delivery or failure reason.
The checklist and the reply body never reach the log.
