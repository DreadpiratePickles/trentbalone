# 2026-09-20 — Daily progress and Hermes parity check (02:50)

Standing instruction from Bobby (set 2026-09-20): each night, summarise progress, research what
Hermes shipped this week, and propose up to five small testable items. Autonomous; nothing
implemented here. HEAD at check time: 8a07b0d (pushed).

## 1. Progress since the previous check (first run; window: the last 36 hours)
1. The shippable goal closed: clean-checkout suite, web suite, typechecks, scans, binaries and the
   three live proofs green; repo made public; CI green again (run 35423798575).
2. The upgrade round opened: four discovery reports, a design with options, an independent Fable
   review (reject, then v2), and nine gate decisions taken (packs with personas, core skill source,
   business and media in parallel then social, outbound SMS only, docker-preferred media, MCP
   toolsets plus a Claude file, creator text-only first, cut RAG scope, Buffer yes and X no).
3. Wave 1 landed: the side-effect gate (class floor, per-call binding, idempotency tokens,
   inbound provenance, external spend), trent connect, trent brain import with citations, the
   three packs with crew personas and thirteen trade skills, trent mcp serve over toolsets plus
   the Claude export, the media toolset with working transcription and orchestrator.resume.
4. Wave 2 partly landed: the doctor no longer loads Prisma on an empty profile (Linux binary
   fixed), media_image (live proof hit a 429: the Gemini plan has no image quota), Hermes and
   Codex exporters with a passing live Hermes import.
5. Finished but held by Bobby's pause, uncommitted in the working tree: the business toolset
   (Stripe, Calendar, Square, outbound SMS), the retrieval golden gate, the social toolset, and
   the Linux binary run fix (app-store predicate).
6. Blocked on Bobby: the pause itself; the platform applications (Meta, TikTok, YouTube, Google
   Business Profile, Twilio 10DLC); image-generation quota on the Gemini plan.
7. Found and recorded for a follow-up: the social toolset's top-level app-adapter imports
   re-break the Linux binary (make them lazy before landing); the compiled binary is never
   durable (prisma init.sql not embedded); a cwd without .claude/skills fails the first seat
   step; --json stdout carries two debug lines; Bun auto-loads .env.local (one accidental
   15-cent call).
8. Scheduled: this daily check (02:07) and a one-time deferred-decisions reminder (09-21 09:03).
9. Tooling lesson today: config blocks are cut by marker onto the split schema; isolate.sh now
   regenerates the Prisma client after pruning (a stale generated dir produced one false red).
10. Commit count in the window: 39 on feature/trent-fleet-v2, all pushed.

## 2. Hermes this week (primary sources; full table appended to
## 01_discovery/output/hermes-feature-inventory-2026-09.md, "New since 2026-09-14 (checked 2026-09-20)")
Newest release is still v2026.9.14 = v0.21.3 (2026-09-14). No release since; main is 3,918
commits past the tag (701 touching docs), with curated notes promised for v0.22.0. 63 items on
main or in the live docs are not in our inventory. The ones that change what a user can do:
usage reporting (`hermes usage --json`), a queue a user can edit (`/queue list|edit|rm|move`),
auto-recovery cycles for the agent loop, provider key pools and provider-plugin hooks,
`session_search` with time windows, `delegate_task` with images, cron failure incidents with
acknowledgement and a quota hold, shared Kanban boards across homes (their docs previously said
single-host), `read_file` SQLite schemas, a fail-closed JSON-RPC client-capabilities model.
Most of the rest is Desktop polish, Slack and Discord surface features, or FAL catalog rows.

## 3. Proposals (rulebook principle 1: outcomes, not feature count; none implemented)
1. `trent usage [--json]`: today's and this month's spend by surface, seat, model and provider
   from the spend ledger (46d030e, fbb06ce), plus token totals. File: new
   `apps/cli/src/commands/groups/usage.ts` (+ two registration lines). Failing test: a profile
   with three ledger rows across two surfaces prints both totals and `--json` returns them in
   integer cents. Cost: half a day. Outcome: a founder can answer "what did this cost" without
   reading a file.
2. Queue editing for scheduled posts and cron jobs: `trent cron queue list|edit|rm|move` over the
   jobs.json the social toolset's post queue and cron already use. Files:
   `apps/cli/src/commands/groups/cron.ts`, `packages/trent-core/src/tools/cron/`. Failing test:
   a queued post is moved and its bound approval stays valid only if the content is unchanged;
   an edit that changes the text re-asks. Cost: one day. Outcome: a queued post can be fixed
   without cancelling and re-approving everything.
3. Cron failure incidents: after N consecutive failures of one job (`cron.failure_repeat_alert_hours`
   style), one alert through the gateway and a `[CRON_FAILURE]` marker, silenced until
   `trent cron incidents ack <job>`; a quota hold when the provider returns 429 until the window
   resets. Files: `packages/trent-core/src/cron/CronRunner.ts`, `apps/cli/src/commands/groups/cron.ts`.
   Failing test: three failures produce one alert, not three; an ack silences; a 429 sets
   `quota_hold_until` and the tick skips until then. Cost: one day. Outcome: an unattended
   heartbeat or sweep stops spamming and stops burning quota.
4. `session_search` time windows: `after`, `before` and shorthand `7d`, `24h`, `2w`, plus
   `exclude_session_ids`, on the tool and on `trent sessions search`. Files:
   `packages/trent-core/src/tools/session_search/`, `sessions/search.ts`. Failing test: a phrase
   in two sessions a week apart is found only in the window asked for. Cost: half a day.
   Outcome: "what did we decide last week" works as asked.
5. Agent auto-recovery cycles: when a run fails on a provider or tool error, retry the failed
   step up to `agent.auto_recovery_cycles` (default 1) with the error in the prompt, then stop;
   never for approval parks or budget stops. File: `packages/trent-core/src/orchestrator/` (a
   small hook beside resume.ts). Failing test: a step whose first call throws a transient error
   completes on the second cycle; a second failure ends the run failed with both errors recorded;
   a parked approval is not retried. Cost: one day. Outcome: fewer runs that die on one flaky
   call, without hiding real failures.

Rejected as feature-count: Desktop font and pill polish, FAL model catalog rows, Slack pasted
tables, Discord auto-threads (no gateway user yet asks), provider key pools (one key today).

## 4. Status
- Tests on HEAD 8a07b0d (clean worktree): tsc 0, core build 0, repo-scan 0, vitest 3296 passed
  / 1 skipped after regenerating the Prisma client (the isolation prune had removed it; the
  script now regenerates after pruning).
- CI: run 35495253024 on 8a07b0d in progress at check time; the previous run 35494019000 on
  2fc8b77 succeeded.
- Most important next action: on Bobby's "continue", land the four finished wave-2 tasks in the
  recorded order (Linux run fix, social with lazy adapter imports, business, retrieval gate), then
  the follow-ups from the Linux findings.
