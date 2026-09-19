# The heartbeat: `trent heartbeat`

```
npm run cli -- heartbeat start
npm run cli -- heartbeat start --once
npm run cli -- heartbeat status
npm run cli -- heartbeat runs --last 10
npm run cli -- heartbeat sweep --now
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

The pass proposes **itemised deltas, never a rewritten block**. Each block goes to the model with
every entry addressed by an id, and the answer may only be `append`, `replace`, `remove` or
`merge` over those ids; code applies them, so an entry the model never mentions survives by
construction. A proposal is all-or-nothing, and one that would take out more than
`memory.consolidation_max_removal_ratio` of a block's entries (default 0.3, never fewer than one
entry) is refused whole and written to the ledger as a `reject` row — so a night where the model
tried to empty a block is visible in `trent improve history` rather than silently retried. The
draft carries both the operations and the text they produced, which is what keeps a promotion and
its rollback byte-exact. A `read_only` block joins the pass only while
`memory.consolidation_may_edit` names its label, and even then a seat still cannot write it and a
human still promotes the draft.

## Unattended sweeps

With `heartbeat.sweep.enabled` (default **false**) a tick may also run one self-improvement sweep,
so the loop that reads the founder's checklist is also the loop that improves the fleet. It is
opt-in: a profile that already runs a heartbeat keeps its exact behaviour and its exact bill until
the key is set.

```yaml
heartbeat:
  enabled: true
  sweep:
    enabled: true          # off by default
  sweep_interval_hours: 24 # at most one sweep this often
improve:
  sweep_cap_cents: 100     # the hard cap on one sweep, integer cents
budget:
  daily_cap: 1000          # the day's ledger the cap is taken from
```

A tick sweeps only when all four hold, checked in this order:

1. **opt-in** — `heartbeat.enabled` and `heartbeat.sweep.enabled` are both true;
2. **outside quiet hours** — the same window a tick obeys; a quiet tick consolidates memory and
   nothing else;
3. **the interval** — `sweep_interval_hours` has passed since the last sweep in
   `<profile>/heartbeat/runs.jsonl`, so a restart cannot buy a second sweep;
4. **headroom** — the day's ledger still holds `improve.sweep_cap_cents`. That ledger is the
   heartbeat's own history: every tick's `costCents` and every sweep's, for the current local day,
   against `budget.daily_cap`. It is the only record of what the machine spent while nobody was
   watching.

Whichever of the four stopped it is written to the tick's own row as `sweepSkipped`
(`disabled`, `quiet_hours`, `interval`, `budget`), so a sweep that never happens is as visible as
one that did.

The sweep itself runs **offline**: `skipLLM`, no gate runner and no judge, so no model is called
and the meter reports a real zero. Reflection costs money and stays with the founder's own
`trent improve sweep --live`. What an unattended sweep does is distil skills from the traces the
fleet has produced, retire what nobody uses, and leave every draft in quarantine. **Nothing is
promoted.** `trent improve status` reads the drafts and `trent improve promote <draftId>` is still
the only way one reaches a seat.

What it did is written to the tick's row as `sweep` — drafts produced, how many the gate passed and
are awaiting promotion, how many are still quarantined, how many were rejected, the spend against
the cap, and why seats produced nothing — and delivered to `gateway.owner` through the same
gateway manager a reply uses. With no owner configured the row carries `deliveryError` and the
counts stay on disk.

`trent heartbeat sweep --now` runs one immediately, through the same port with the same cap, past
the interval and past the opt-in: it is the founder asking. The day's ledger still applies, and a
day with less than the cap left refuses rather than half-spending. It reports to the terminal
instead of messaging the owner, and leaves its own `sweep` row in the history, which never moves
the next tick. Without `--now` the command refuses and names the flag.

`trent heartbeat status` shows whether the unattended sweep is on, its cadence, and the last
sweep's time, trigger, counts and cost.

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
for a failed run, `deliveryError` and `text` when a reply could not be sent, `consolidated`
when memory consolidation ran, and `sweep` or `sweepSkipped` for the unattended sweep. Decisions
are `quiet`, `no_reply`, `reply` and `failed`; a row whose decision is `sweep` is the one
`trent heartbeat sweep --now` leaves, and it is a command, not a tick.

`start` takes `<profile>/heartbeat/runner.lock` with its pid and refuses (exit 3, "already
running") while another live process holds it; a lock left by a dead pid is taken over. The command
claims Ctrl+C as well as SIGTERM and SIGHUP: each releases the lock, the manager and the runtime,
and the process exits 130 only once that release has settled. `--once` ticks one time and
exits, for launchd, systemd timers or system cron.

`status` reports `enabled`, `intervalMinutes`, `activeHours`, `quietNow`, `running`, the last row,
`nextTickAt` (the last TICK row plus the interval; `null` before the first tick) and `sweep`
(`enabled`, `intervalHours`, the last sweep record and `nextAt`).

## Logging

The structured log carries the decision, the duration, the cost and a delivery or failure reason.
The checklist and the reply body never reach the log.

## The daily spend ledger the sweep is metered against

`budget.daily_cap` is one cap over every surface, not one per surface. Each charge is appended as
one JSON line to `<profile>/spend.ndjson` (mode 0600, append-only) —
`{ at, surface, run_id, seat?, model, provider, cents, tokens }`, integer cents throughout — and
the surfaces read that same file: the REPL opens its ticker on the day's total and refuses the
next turn once the total reaches the cap even if another surface spent it, a run records what it
cost through the orchestrator's run-end hook tagged with the surface that asked for it (`repl`,
`run`, `gateway`, `cron`, `heartbeat`, or `unknown` when the surface does not say), and the
unattended sweep both charges the day for what it spent and computes its headroom from the day's
cross-surface total. A sweep is refused with `budget` when that total leaves less than
`improve.sweep_cap_cents`; before this ledger the heartbeat measured its headroom against its own
`runs.jsonl` alone, so a founder who had spent the cap in the REPL at noon still bought a sweep at
midnight. The two views are reconciled by taking the larger, so a surface that does not yet write
the ledger cannot buy extra headroom.

The file is the layer, not the store: the durable store's schema is derived from the read-only
`apps/web` Prisma schema, so there is no spend table to add without editing it, and under Node
every durable layer is ephemeral anyway (AGENTS.md defect 9) — a store-only ledger would forget
the day's spend on every process exit. `SpendIndexPort` is the seam for a store-side index when
the schema can carry one; the file stays the record.

```
npm run cli -- budget status
npm run cli -- budget status --json
npm run cli -- budget status --date 2026-09-17 --json
```

`budget status` prints the day (on `heartbeat.active_hours.tz`), the total against
`budget.daily_cap` with what is left, the spend of each surface that charged that day largest
first, `budget.per_run_cap` and `improve.sweep_cap_cents`, and the path every surface appends to.
It reads and writes nothing, so `--dry-run` reports exactly what a normal run does.
