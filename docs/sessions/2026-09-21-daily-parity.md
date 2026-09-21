# Daily progress and Hermes parity check, 2026-09-21

Standing instruction (Bobby, 2026-09-20): every day at 02:00 ask how much progress we made and, as
researchers at Anthropic, what would make Trent as good as Hermes Agent is today. This run started
at 12:57Z (the scheduler fired late); previous check: docs/sessions/2026-09-20-daily-parity.md.

## 1. Since the previous check (HEAD 8a07b0d then, 844da15 now; 28 commits)
1. Pause lifted after Bobby's five deferred decisions (016eaf3): SMS outbound-only, wire
   `trent sandbox build --media`, platform applications last, creator clipping on, RAG reranker
   waits for a measurement.
2. Wave 2 closed: Linux binary run fix + retrieval golden gate (928ca0f), business + social
   toolsets behind the gate with lazy app-adapter imports (fd51f62).
3. Wave 3 closed: `trent usage` (8d4897a), media sandbox build + creator clipping (659ec6e), cron
   incidents / quota hold / queue editing (80a5bc6), binary durable + `--json` one document + no
   `.env.local` autoload (0d9f3ca, web fix 824560d), Claude/Codex/Hermes importers (f898d0b),
   session-search windows + auto-recovery cycles (9a71a99).
4. Follow-up wave closed: doctor rows 19-20, `budget status` through the shared spend report (a
   real "" vs "unattributed" divergence found by the guard test), quote/appointment idempotency
   tokens, Hermes live A2A discovery proof with zero spend, A2A v1.0 on the wire beside 0.3.0 so
   Hermes's `a2a_call` now gets a task, spec-3.4.3 continuation semantics, mismatching
   contextId/taskId rejected (a0fc407 .. a1a4e04).
5. Evidence at the last close: clean-HEAD suite 3608 passed / 1 skipped, 370 files; CI green on
   c403e92, 14e1b04, a1a4e04. One CI flake seen: `browser.chromium.test.ts` 60 s timeout, green
   on rerun.
6. In flight: nothing. Blocked on Bobby: platform applications (Meta, YouTube, TikTok, Google
   Business Profile), Gemini image quota (429), release checklist steps.
7. Blocked on a measurement: RAG reranker / query prefixes (recall@8 on real documents).
8. Hermes-side gap: its A2A client never resends a taskId, so it cannot answer a Trent task that is
   `input-required` (docs/a2a.md).
9. Method unchanged: scripts/dev/isolate.sh on a detached worktree of HEAD, explicit-path commits,
   push to the feature branch only.
10. Working tree clean at check time.

## 2. Hermes in the last 7 days (primary sources; one Opus agent, no subagents)
Appended to 01_discovery/output/hermes-feature-inventory-2026-09.md as "New since 2026-09-20
(checked 2026-09-21)": 72 items not previously listed (68 behaviour changes on `main`, 2 docs-only,
2 corrections to earlier rows). No new release or tag: newest release is still v2026.9.14 = 0.21.3,
which is what this machine runs; newest `main` commit ea0c2b82 at 2026-09-21T12:06Z. The five most
consequential upstream changes, with sources, are in that section: one gateway per host multiplexing
profiles; cron jobs follow the main model at fire time with per-job pins and reasoning effort;
external-process model-provider plugins and plugin-registered wire dialects; one connector/MCP
setup operation with `mcp.discovery_concurrency`; session-storage journal-mode command and
maintenance refusing under a live writer. Defaults that changed upstream and touch nothing in Trent's
exporters (checked: no HERMES_HUMAN_DELAY, command_denied_message or Gemini key reroute in
packages/trent-core/src/fleet): noted, no action. The agent's naming correction concerns Hermes's
registered TOOL names (`cronjob_manage`, `todo_list`); Trent's Hermes export maps TOOLSET names
(`cronjob`, `todo`), which are unchanged, so export-hermes.ts stays as it is.

## 3. Judgement: outcomes, not feature count (rulebook principle 1)
Of the 72, four change what a Trent user can do or lose; the rest are Hermes catching up on things
Trent has (curator-style pruning, incidents), Desktop polish, or provider plumbing for providers we
do not route to. Proposals, small and testable, none implemented today:

1. **One gateway per host.** Today two `trent gateway start` on the same profile both attach every
   adapter, so a Telegram or Discord message is answered twice (`GatewayManager.start` holds no
   lock; checked). File: `packages/trent-core/src/gateway/GatewayManager.ts` (+ a `lock.ts` under
   `gateway/`, profile-dir pid lock with a liveness check). Failing test: `GatewayManager.test.ts`,
   "a second start on the same profile refuses with the first's pid and starts no adapter"; and
   "a stale lock from a dead pid is taken over". CLI: `trent gateway start` prints the pid and exits
   3. Cost: ~150 lines, one afternoon, no spend.
2. **`reasoning_effort` on the model call.** Google's OpenAI-compatible endpoint accepts
   `reasoning_effort` (Hermes now sends `medium` by default on custom endpoints); Trent sends only
   `temperature` (`model-gateway/attempts.ts:96`), so `gemini-3.5-flash-lite` thinks at the provider
   default on every seat, which is where per-run cost goes. File: `config/sections/model.ts`
   (`model.reasoning_effort: none|low|medium|high`, per-seat override in `seats`), `model-gateway/
   attempts.ts`. Failing test: `model-gateway` request test, "the body carries reasoning_effort when
   configured and omits it otherwise"; a live proof on the key with the spend ledger showing the cost
   delta between `low` and `high` on one golden. Cost: ~80 lines plus one measured live run (cents).
3. **Maintenance refuses under a live writer.** `trent sessions prune`, `trent brain` git
   operations, `trent fleet import` and `trent doctor --fix` write the profile while a REPL, gateway
   or cron runner may be writing it; SQLite answers "database is locked" mid-run or the brain repo
   gets a half commit. File: a `profile/live-writer.ts` (the same pid lock as proposal 1, held by
   REPL, gateway, cron runner, `trent run`), consulted by the maintenance commands in
   `apps/cli/src/commands/groups/maintenance.ts` and `sessions.ts`. Failing test: "prune under a
   held live-writer lock exits 3 naming the pid and deletes nothing". Cost: ~120 lines; shares the
   lock with proposal 1, so do them together.
4. **Per-job model pin on cron.** Trent's cron jobs carry no model (checked `cron/config-schema.ts`)
   and run on the configured model at fire time, which is Hermes's new default; what Trent lacks is
   the pin: a nightly digest on the cheapest model and one weekly review on the judge model. File:
   `cron/config-schema.ts` (`model?: string`), `cron/CronRunner.ts` (pass `job.model` into the run
   input), `apps/cli/src/commands/groups/cron.ts` (`--model`). Failing test: `CronRunner.test.ts`,
   "a pinned job's run input names the pin; an unpinned job's names nothing, so the gateway picks the
   configured model at fire time". Cost: ~60 lines, docs/jobs.md one row, docs-truth counts unchanged.
5. **Not proposed:** external-process provider plugins (Trent routes to one provider by decision 1
   of the implementation plan; a plugin boundary is a feature count until a second provider is
   wanted), MCP discovery concurrency (no user has more than a handful of servers), session
   journal-mode switching (Trent's store already runs WAL with busy_timeout; `store/scenarios.ts`).

## 4. Status
- Tests on HEAD 844da15 (clean worktree, scripts/dev/isolate.sh, whole core + CLI suite): tsc 0,
  core build 0, repo-scan 0, vitest 3608 passed / 1 skipped, 370 files.
- CI: run 35549968714 on 844da15 succeeded.
- Most important next action: proposals 1 and 3 together (one profile pid lock: no double replies
  from two gateways, no maintenance under a live writer), then proposal 2 with its measured cost
  delta. Everything else open waits on Bobby (platform applications, image quota, release steps).
