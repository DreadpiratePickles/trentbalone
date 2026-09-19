# 2026-09-18 — Where Trent stands vs Hermes; harness and shared-brain assessment

Goal (Bobby): make Trent a better Hermes — every Hermes feature plus Trent's nine role seats,
persistent memory, self-improving agents and a shared brain. First deliverable: an honest status
("where we stand") and a plan ("what we need to do"), backed by research and code audit.
Model routing: Fable reasons and decides; Opus agents do the reading, research and implementation.

## Resume point (read, not re-audited)
- Branch `feature/trent-fleet-v2`, HEAD `0572c51`, pushed; CI run 35050280461 success (2026-09-16).
- Backlog plan T0.0–T5.2 implemented and verified on a clean worktree (see 2026-09-15 log tail).
- Open leftovers from that log: consolidate.ts only handles two default blocks; Ctrl+C on
  `gateway start` pre-empted by index.ts process.exit; question cards titled "Approval needed";
  migrations unapplied; seat turns bypass core redaction (design question).
- Housekeeping gap: rulebook not copied to `docs/`, no root `CLAUDE.md` (AGENTS.md is Layer 0).
- README/memory disagree on `trent web --start` (refuses vs serves) — to be checked by audit.

## Method
- Five Opus agents in parallel (cap 6): (1) Hermes feature inventory from primary sources;
  (2) agent-harness state of the art 2026; (3) fleet/memory/shared-brain/self-improvement code
  audit; (4) agent-loop/harness + Hermes-parity code audit; (5) the three small leftovers, TDD.
- Outputs land in `01_discovery/output/` (audits, research) and the plan in `02_plan/output/`.
- Design gate: the resulting roadmap needs Bobby's approval before implementation starts
  (CONTEXT.md stage flow). Pre-approved leftovers proceed now.

## Steps
- (in progress) agents launched.
- Housekeeping: rulebook copied to `docs/development_methodology_and_coding_rulebook.md`; root
  `CLAUDE.md` added that routes to AGENTS.md, CONTEXT.md and the rulebook (standing rule 1).
- Agents launched (5 Opus): hermes-inventory, harness-sota, fleet-brain-audit, harness-parity-audit,
  leftovers-fix. Waiting; no inline grunt work meanwhile.
- Lesson: the harness-SOTA research agent fanned out six sub-agents of its own, breaching the
  six-agent cap. Told it to stop spawning and finish itself. Every future brief must say
  "do not spawn subagents" explicitly; the cap is not inherited by nested agents.
- Committed 4caa437 (root CLAUDE.md + rulebook copy).
- Harness-parity audit landed -> `01_discovery/output/harness-parity-audit-2026-09-18.md`
  (54 parity rows: 31 REAL / 13 PARTIAL / 10 ABSENT). Spot-checked in code: `repl/engine.ts`
  `#runTurn(objective)` starts a fresh orchestration run per line (no conversation);
  `repl/index.ts:101` discards `resumeLastSession()` (`--continue` restores nothing). Also:
  no compaction/token counting/prompt caching; no budget stop; no `trent run`; no provider
  retry/429; ollama/deepseek/groq route nowhere; ACP + A2A task endpoints are canned strings
  and `A2A.test.ts` asserts the canned shape (invariant 2 violation); personality inert; no
  hooks/autonomy level/cwd instructions. README stale on `trent web --start` (it serves).
- Fleet-brain audit landed -> `01_discovery/output/fleet-brain-audit-2026-09-18.md`. Spot-checked
  in code: `apps/web/lib/orchestrator-runtime.ts:81-90` ACTIVE_SEATS = 5 seats, analyst/finance/
  escalation -> ceo and sales -> growth (only 5 of 9 seats ever run); `apps/cli/src/commands/
  improve.ts:243` resolves suites via `getCatalogAgent(seatId)` which never matches a seat id, so
  every seat is `no_suite` and can never promote; `sweep.ts` `skipLLM` means GEPA never reflects
  in the CLI; no goldenDir passed; sweep uncapped; heartbeat has no improve call and is off by
  default; shared brain is TF-IDF only (EmbedFn seam never given an embedder); ~14 apps/web
  memory surfaces unwrapped; per-seat budget/model are theatre.
- Leftovers-fix agent landed the three "Left open" items from
  `docs/sessions/2026-09-15-feature-backlog-decision.md` (each RED first, then GREEN):
  1. `consolidate.ts` now consolidates every configured `memory.blocks` block in the one turn —
     `memory`/`user` always, each extra writable block under its own `limit`, `read_only` never
     sent to the model and never rewritten. Extra blocks ride on the same draft (payload gains an
     optional `blocks`; a default profile's payload is byte-identical to before), so one promotion
     or one rollback moves the set. `apps/cli/src/commands/groups/heartbeat.ts` passes
     `config.memory.blocks`. RED: system prompt did not contain the extra block's cap.
  2. Ctrl+C on `trent gateway start` is now graceful. New `apps/cli/src/signals.ts` holds the
     claim: a keep-alive command claims SIGINT/SIGTERM/SIGHUP and exits 130 only after its
     shutdown promise settles; `index.ts`'s global SIGINT handler stands down while a claim is
     live (a second Ctrl+C still exits at once). Test drives a fake `process` through the new
     `overrides.signals` seam and asserts stopAll -> cleanup -> exit:130 in that order.
     RED: no SIGINT listener was registered at all.
  3. `GatewayManager.sendApproval` titles by kind through the new `ApprovalBridge.cardSubject`:
     "A question for you: <action>" for an `ask_human` card, "Approval needed: <action>" otherwise.
     Callback, nonce and delivery record untouched, so reactions and decisions resolve as before.
     RED: the question card's subject read "Approval needed: Ship EU or US first?".
  Stale docs corrected with the code: fleet-memory README, `docs/configuration.md`,
  `docs/heartbeat.md` (consolidation covers every block), `docs/gateway.md` (Ctrl+C is graceful).
  Evidence: `npx tsc --noEmit -p apps/cli/tsconfig.json` 0; `npm --prefix packages/trent-core run
  build` 0; `node scripts/ci/repo-scan.mjs` 0; `npx vitest run --reporter=dot` 0 —
  180 files passed / 2 skipped, 1771 passed / 27 skipped (all 27 skips are "no Docker daemon").
  Not done: `cron start` and `heartbeat start` still register only SIGTERM/SIGHUP (they rely on
  the `exit` hook to drop their lock); only `gateway start` claims the interrupt.
- Leftovers verified by me (4 test files 41 pass; tsc 0; repo-scan 0) and committed one task
  each, each isolate-checked with `git stash --keep-index` + tsc before commit:
  ddb54de (Ctrl+C on gateway start graceful), 7c01283 (consolidation covers every configured
  block), c9de8bf (ask_human cards titled as questions). Full suite on HEAD running.
  Still open from that agent: `cron start`/`heartbeat start` claim only SIGTERM/SIGHUP; a
  configured override of the default memory/user block limit is not honoured by the legacy
  write path (MEMORY_CAPS).
- Full suite on c9de8bf: `npx vitest run --reporter=dot` exit 0, 180 files passed / 2 skipped,
  1771 passed / 27 skipped. Pushed 4caa437..c9de8bf to origin/feature/trent-fleet-v2.
- Hermes inventory landed -> `01_discovery/output/hermes-feature-inventory-2026-09.md` (334 rows,
  Hermes v0.21.3). Harness SOTA landed -> `01_discovery/output/agent-harness-sota-2026-09.md`.
- Key correction from the fleet audit 3.4: apps/web already has memory-tiers (working/episodic/
  semantic + supersedes), wiki-embeddings (real vectors), trench-wiki, vault-memory, capability-
  memory, seat registries, ceo-decision-journal, gbrain; the CLI wraps two modules. The brain plan
  is therefore "wrap and extend", not "build".
- Wrote `02_plan/output/hermes-parity-roadmap-2026-09-18.md` (status + phases A-F + decisions +
  agent-brief rules). Phase A0 defect fixes launched now (4 Opus agents, disjoint files); A1+ waits
  for Bobby's design gate. Fable adversarial review of the plan next.
- SOTA agent's final report: 152 items, 89 sources. Strategic finding folded into the plan: the
  compute-normalised 2026 evidence is against splitting a task across agents by job title; seats
  become capability/permission/verification boundaries stepped through sequentially (ICM), fan-out
  only for read-heavy breadth, critic separate. Also: delta memory updates not rewrites (ACE);
  agent-authored skills need the executing gate (SkillAxe). Plan updated; Fable review next.
- CI on c9de8bf (run 35403293207): every job green except "sandbox / docker-dependent suites":
  `egress/CertificateAuthority.test.ts > mints an IP-SAN leaf when the host is a literal address`
  fails with `asn1 encoding routines::illegal padding` on the Linux runner. No commit since the
  last green run touches egress; suspected nondeterministic DER (serial/high-bit or SAN encoding)
  or a stricter runner OpenSSL. Opus debugging agent launched (TDD; no commit).
- Committed 09646aa (the four discovery docs). Fable design review of the roadmap in flight;
  A0.1-A0.4 in flight. Six agents running: at the cap.
- Fable design review landed -> `02_plan/output/design-review-hermes-parity-2026-09-18.md`:
  APPROVE WITH CHANGES. False premises found: wiki-embeddings is hash vectors without an OpenAI
  key and embedMany is module-private; ACTIVE_SEATS shrink is a recorded product decision
  (SHRINK), not a bug; two invariants I cited in the fork paragraph do not exist. New defects:
  cacheKeyForSeatModel omits dynamicPrompt; writesOnFinish never executed; Node = EphemeralStore.
  Roadmap rewritten as v2 with: truth rule per layer (two stores, no facts table), core embedder
  behind EmbedFn, D0 gates (frozen surface, holdout, pass^k, auto-rollback, hash veto, TPR/TNR),
  context-file scanning moved into A2, golden capture in A0.5, B3/B4/C6/E2-E7 deferred, options
  per major decision. Messages sent to A0.1 (message-list history, gateway continuity, cache-key
  defect, no partial turn after Ctrl+C), A0.2 (test the port, mark wire non-spec), A0.3
  (abort-aware retry, providers as openai+base URL), A0.4 (one event schema).
- A0.2 landed and committed (isolated worktree check: tsc 0, build 0, scan 0, 26 tests):
  AgentRunner port, A2A task lifecycle, ACP chat on the runner, honest 503 without a runner,
  canned literals now repo-scan violations. Isolation now runs on a detached worktree of HEAD
  under the scratchpad (`isolate.sh`) instead of `git stash`, because five agents are editing
  the shared tree concurrently.
- CI root cause found and fixed: `egress/CertificateAuthority.ts` serial() produced non-minimal
  DER 1 time in 512 (leading 0x00 kept when the next byte < 0x80); not environmental (same runner
  image and Node on the green and red runs). Committed after isolated check (egress suite 39 pass,
  tsc 0, build 0, scan 0). Follow-up: a doctor hint for a persisted bad root at
  `~/.trent/egress/ca.crt`.
- A0.4 landed -> 19960af (`trent run`, stream-json on verbatim OrcEvents, exit codes 1 and 7,
  README/troubleshooting truth on `web --start`). docs/getting-started.md was split: A0.1's
  conversation paragraph held back via `git update-index --cacheinfo` on a variant blob.
- A0.5 landed -> (this commit) golden capture on; docs/configuration.md carries both A0.5's and
  A0.1's sections and goes with A0.1's commit.
- Pushed through fe43844. Observation from A0.5's test stderr: apps/web `executeSeatModel` logs the
  raw objective text inside its provider-error line ("failed 404 ... for <objective>"), so an
  objective containing a secret is echoed to stderr unredacted (the golden itself is redacted,
  proven by test). Low severity, apps/web-owned; register with the known defects at the next
  AGENTS.md edit rather than fix now.
- A0.1 landed in three commits: REPL conversation/sessions/budget stop/export (orchestrator/index.ts
  committed as a variant without A0.3's in-flight hunk, via a scratch blob); gateway thread
  continuity; apps/web cache-key fix (invariant 1 bug exception, own commit, test; web suite file
  green, web typecheck 0). Follow-up registered: the key still omits toolLoopContext.
- A0.3 landed (retry/backoff/abort, provider aliases as openai+base URL, unroutable provider fails
  with exit 3, price table + model_overrides wired end to end). Phase A0 complete.

## State at end of session (2026-09-18)
- Commits today: 4caa437 (root CLAUDE.md + rulebook), ddb54de/7c01283/c9de8bf (leftovers),
  09646aa (four discovery docs), a5d14e8 (roadmap v2 + review), 2b380f5 (ACP/A2A real runtime),
  8b369d6 (cert serial), 19960af (trent run), fe43844 (goldens), 1e3ece6/d5157c1/59ffde1
  (conversation, gateway continuity, web cache key), 3ae533c (defects registered), then A0.3.
- Gate: Bobby's decisions in `02_plan/output/hermes-parity-roadmap-2026-09-18.md` section 4.
  Next artefact after approval: `02_plan/output/implementation-plan-hermes-parity.md`.
- Follow-ups not yet built: doctor hint for a persisted bad egress root; cache key still omits
  toolLoopContext; cron/heartbeat start claim only SIGTERM/SIGHUP; MEMORY_CAPS override for the
  default blocks; the 16 live tests never run in the standard gate.

## Design gate: approved (Bobby, "approved")
- Read as approval of the roadmap direction and of every recommendation in section 4; the
  reading is written into `02_plan/output/implementation-plan-hermes-parity.md` so it can be
  reversed. Wave 1 launched: A1 (context management + per-seat prelude + personality), A2.1
  (workspace context files), A2.2 (autonomy + hooks + deny globs), B1 (unshelve seats, apps/web
  scoped exception), B0.2 (skill stores), A0.6 (leftovers).
- Bobby answered the gate one question at a time: TS harness; sales seat + browser toolset;
  scoped apps/web exception for the shrink; eval suites from goldens only (not agent-drafted);
  slash module merge-then-delete; judge = different Gemini model on the same key; Gemini
  embeddings allowed; sweep cap = per_run_cap; release after Phases A and B. Plan header updated.
- Wave 1: A2.1 landed (workspace context files), amended once: the first cut's config hunk had
  swallowed the adjacent [A2.2] block (-U0 hunks merge adjacent insertions) and the isolate result
  was masked by a pipe. Rule from here: isolate output goes to a file and a commit runs only after
  `grep -q "ISOLATED rc=0"`; adjacent blocks are cut by their markers, not by hunk.
- A0.6 landed (doctor egress-root hint, SIGINT on cron/heartbeat, configured block limits).
- Wave 1 complete: 26e606d (A2.2 autonomy/hooks), 4f32807 (B1 apps/web scoped exception),
  e7bfd4e (A1 context tiers/compaction/per-seat prelude), and B1 core. D0 still running.
  Follow-ups found by agents: apps/web/lib/agent-routing-context.ts still biases the planner
  against the four seats (second apps/web file; needs Bobby); improve/trace-writer.ts CORE_SEATS
  third roster (D1); session hooks and workspace context not yet wired into headless/prelude
  (wave 2 W2.0); cache_control and intra-step tool-history need apps/web seams (recorded in
  e7bfd4e); improve/golden-capture.test.ts is load-flaky.
- Evidence: full suite on a clean HEAD worktree at 95d8981: tsc 0, core build 0, repo-scan 0,
  vitest exit 0 (`scratchpad/iso-head-full.log`). The working-tree failures were D0's in-flight
  RED files under improve/ only.
- Wave 2 launched: W2.0 (workspace context + session hooks wiring, /context, slash merge/delete),
  B2 (seats as capabilities), C3 (core embedder), with D0 still running.
- Bobby extended the apps/web exception to `agent-routing-context.ts` (decision 10). B1.2 launched.
- B1.2 landed (apps/web routing context, second exception): web suite 2825 pass.
- D0 landed (improvement gates: frozen surface, holdout, pass^k, auto-rollback, hash veto, TPR/TNR, sweep cap). Note: an in-flight agent has moved the [A2.1] workspace block in schema.ts; diff-hunk cutting is unsafe there, cut by marker plus explicit edits.
- B2 landed (seat capabilities, budget abort, model tiers, fleet show). Follow-up B2.1: models config key + headless forwarding.
- Wave 2: W2.0 landed; C3+C4 landed together (9f63c7a; interleaved memory config). Bobby's usage
  limit interrupted four agents mid-task (A3, D1, E2, B2.2); their partial edits are in the tree.
  Known red on HEAD: registry.test.ts (fleet show sample exits 3) and delegate.repl.test.ts (an
  extra delegated analyst child) from the seat commits; B2.2 owns the fix. Resuming the four.
- B2.2 landed: fleet show dry-run branch; delegate fixture fixed (route repair adds a support step now). HEAD expected green.
- E2 landed (security audit, release checklist with 6 source disagreements).
- B2.1 landed (models tiers key wired end to end).
- A3 sent back: its bridge adapters break 8 REPL tests (tools.test, tools.repl.test, delegate.repl.test); it now owns those test files.
- D1 landed (goldens as suites, --live, judge model, roster from fleet; dry-run on goldens commands).
- A3 landed (disclosure bridges, todo, clarify, session_search; REPL tests assert both sides of the threshold).
- C2 landed (brain repository, truth rule, migration, signposts, brain_read, trent brain). Follow-up: repl/fleet-memory.ts forwards brain.enabled.
- E1 built (ledger, rollback, /checkpoints, /rollback); sent back to open the checkpoint session from headless and the REPL turn boundary.
- D2 landed (heartbeat metered sweep, opt-in). Follow-up D2.1: export the goldens suite builder from commands/improve.ts so unattended sweeps gate.
- E1 landed (agent-write ledger, checkpoints, /rollback, wired in headless). config/schema.ts nearing 500 lines: extract sub-schemas before more blocks land.
- C1 done but HELD: its schema block would take config/schema.ts to 506 lines (R1 split in flight
  on a separate worktree) and its recall.ts hunks are interleaved with C5's provenance hunks, so
  C1 commits after R1 and together with C5 (same pattern as C3+C4). C1 finding that corrects the
  plan: `apps/web/lib/db.ts` builds a Postgres client, so `DATABASE_URL=file:<profile>/trent.db`
  (what headless sets under Bun) makes every app store call throw; app tiers are durable only with
  Postgres, ephemeral otherwise (the doctor's app-memory line says which). The "Bun durable"
  premise was wrong for the app tiers; the core SQLite store is what Bun makes durable.
- D2.1 landed (shared sweep builder; unattended sweeps gate).
- D3 done (curator: lifecycle aging, hash-chained mutation ledger, single undo, provenance policy, agent-skill scan gate, trent curator) and HELD with C1 for R1's schema split. Limit recorded: curator.scan_agent_skills is read by nothing until tools/index.ts wiring (C5 owns it now).
- R1 landed (schema split into config/sections, 485 -> 141 lines). The shared working tree keeps the agents' monolithic schema.ts until their blocks are cut onto HEAD; sync it with git checkout when the last one lands.
- R1 fix: e2d8a42 omitted config/sections (directory staged as one entry); added in the next commit from the verified isolation copy. CI on e2d8a42 alone is expected red.
- D3 landed after R1. Rule: every commit that adds a config key regenerates schema-split.snapshot.json (scratchpad/regen-snapshot.mjs in the isolation worktree).
- C1 follow-up done: repl/fleet-memory.ts passes embedderForProfile (hybrid recall live), forwards brain keys, mirrors episodic writes to app tiers, consolidation writes app facts. Held with C5 (recall.ts interleaved); snapshot to regenerate for app_sources + provenance.
- C1+C5 landed (241ec38). E3 landed (A2A spec transport, stdio ACP). isolate.sh: a directory source now replaces the target instead of nesting into it.
- F0 landed (release sources reconciled; Pages gated on a release). scripts/dev/ carries the isolation helpers for future sessions.
- F0 landed minus the two workflow files: the session token lacks the GitHub `workflow` scope
  (push rejected), so pages.yml/release.yml edits are held in
  `05_release/output/pending-workflow-changes.patch` for Bobby to apply after
  `gh auth refresh -h github.com -s workflow`. L1 landed: live proofs A and B passed on the key
  (15c and 21c). Findings: previous-turn text also reaches the next run via recall/app memory
  (the interrupted-fragment rule holds only on history); the app's unverified-tool-claim guard
  fired once.

## Queued: the shippable goal (Bobby, 2026-09-19)
After D4 and D5 land and the wave is closed, run the /goal prompt Bobby supplied ("Take Trent to a
shippable state for its first release ... prove it with passing checks on a clean checkout of
HEAD"). Its done-criteria, constraints, verify, progress (docs/sessions/YYYY-MM-DD-shippable.md),
stop rules and output are recorded verbatim in the chat transcript of this session and summarised
in the memory note; the helpers it names live in scripts/dev/. Blockers already known for it:
the GitHub workflow scope (pending-workflow-changes.patch), W3.1 wiring, the D2 spend ledger,
the interrupted-fragment rule on recall and app memory.
- D4 landed (goals, gates before judge, verify_on_stop). Not done: auto_continue has no surface; no goal judge model wired.
- D5 landed (bdaab39). Working tree synced to HEAD (schema.ts, defaults.ts, sections/memory.ts,
  doctor/index.ts, commands/index.ts). Wave 3 closed.

## Wave close evidence (clean worktree of HEAD bdaab39)
See `scratchpad/iso-wave-close.log`: tsc, core build, repo-scan and the full core+CLI vitest
run recorded below in the final summary lines of this session.
tsc exit=0
core build exit=0
repo-scan exit=0
      Tests  2853 passed | 1 skipped (2854)
 Test Files  287 passed (287)
vitest exit=0
