# 2026-09-15 — Feature backlog decision (from ~/Downloads/trent-todo.txt research)

Goal: Bobby ran a peer survey (ever-gauzy + 18 ERP/PM peers + AI-agent-platform peers) in another
session and produced a ~90-item backlog. Task: decide which items to include in Trent without
duplicating what already exists, and write that decision down.

## Method
- The research was written against the web app alone; the branch now has `packages/trent-core`
  (Hermes toolsets, cron, messaging gateway, fleet memory, egress, GEPA/improve loop) which covers
  a lot of it. So: audit every backlog item against the real code first, with file evidence.
- Five Opus Explore agents, one per cluster (runtime / HITL+policy / observability+memory /
  tools+platform / work+money+CRM+channels). Each reports EXISTS / PARTIAL / ABSENT per item.
- Then synthesize into `02_plan/output/feature-backlog-decision.md`.

## Steps
- (in progress) audit agents launched.
- Cluster B audit landed -> 02_plan/output/audit/cluster-b-hitl.md
- Cluster E/I audit landed -> 02_plan/output/audit/cluster-e-i-tools-platform.md (bugs found: backup-health.ts:21 wrong script name; CompanyMember.permissions dead column; outbound webhook surface is descriptor-only)
- Cluster F/G/H/J audit landed -> 02_plan/output/audit/cluster-f-g-h-j-work-money-crm-channels.md (bugs: gateway start no agentHandler; voice STT stub; sequences.ts steps[0]; Task/Goal/Cycle disconnected)
- Cluster A and C/D audits landed -> 02_plan/output/audit/ (bugs: CLI cron has no runner + unregistered; quiet-hours.ts unused; OTelExporter never instantiated; IdempotencyManager unwired; SSH/E2B CLI backends are mock strings)
- All five audits in. Tally over 74 audited items: 8 EXISTS, 49 PARTIAL, 17 ABSENT.
- Wrote `02_plan/output/feature-backlog-decision.md`: phase 0 (12 truth fixes: gateway drops
  chat messages, chat approvals don't resume runs, cron has no runner, OTel exporter never built,
  voice stub is a canned string, SSH/E2B backends are mocks, IdempotencyManager unwired,
  quiet-hours unused, backup-health wrong script, stale security doc, dead permissions column,
  sequences bug), then phases 1 autonomy (cron runner, HEARTBEAT.md loop, gateway push alerts,
  sleep-time memory consolidation), 2 conversation model (threads=sessions, double-texting policy,
  reactions as approvals, ask_human tool), 3 trust (class-level trace policy rules, prompt
  redaction, MCP install scan + output scrub, signed audit export, per-company caps + DLQ view),
  4 fleet lifecycle (AgentVersion on the improve ledger, export/import format, N memory blocks),
  5 work graph + webhooks (needs Bobby: touches apps/web schema — invariant 1).
- Refused with reasons: ERP/finance/CRM/HR domain, SSO/roles/GDPR/i18n/mobile stage, web-UI items
  (plugin slots, dashboards, Kanban/Gantt, PQL, custom fields), 100+ fan-out, outbox, rules engine,
  IntegrationMap, per-user OAuth, importers, approval chains, time-travel fork, voice, device nodes.

## Evidence
- Audit tables: `02_plan/output/audit/cluster-{a,b,c-d,e-i,f-g-h-j}*.md` — file:line per claim.
- No code changed this session. Nothing run beyond `ls`/`cat`/`grep`.

## Left open
- Bobby's call on §6 (phase 5 / invariant 1). Phases 0–4 need no new authorization.
- Next session: start phase 0 at 0.1 (gateway agentHandler) — failing wire test first.

## Approval + implementation (same day)
- Bobby: "i approve your plan… make an implementation plan and then implement it"; phase 5 is
  mine to decide → option B+ (5.1 as bug fix, then 5.2, both last, apps/web, own commits + tests).
- Plan: `02_plan/output/implementation-plan-backlog.md` (T0.0–T5.2). Execution in waves of ≤6 Opus
  agents with disjoint files; agents don't commit — orchestrator verifies gates and commits.
- Wave 1 (parallel): T0.0 runtime extract, T0.5 voice stub, T0.6 terminal mocks, T0.7 idempotency,
  T0.9+T0.10+T0.11 docs/web fix. T0.4 OTel starts after T0.0 (needs headless.ts) — actually the
  config/traces/doctor parts are independent; only the wiring line waits.
- Wave 1 committed: f821db3 (T0.9), 5fccbb4 (T0.10/11), dc52500 (T0.6), 1cb11d6 (T0.5), 1da3113 (T0.0).
  Evidence per task in the commit messages; core+cli suite 1314 pass at 1da3113 (T0.7 RED tests
  were the only red, by design, in flight).
- Wave 2 launched: [T0.1+T0.2] gateway wiring, T0.3 cron group, T0.4 OTel; T0.7 still running.
- Wave 2 committed: 250f9bb (T0.7), 4f52fb4 (T0.3), 49c0853 (T0.4), 27d523c (T0.1+T0.2; shared
  servers.ts hunks so one commit). Suite 1402 pass / 27 skip at 27d523c.
- Follow-up in flight: RunApprovalLink only observed gateway-started runs (headless.ts was owned
  by T0.4 at the time). Agent resumed to add `busHooks` to the headless runtime so every run
  (REPL/cron/heartbeat) posts its approval card to gateway.owner.
- Milestone 1 started: T1.1 cron runner and T1.4 memory consolidation running in parallel.
- Committed: 5e0656a (approval link on runtime bus hooks — every run posts its card), 3b28dc3
  (T2.3 reactions; GatewayManager subscription deferred to T2.2's commit since same constructor),
  08e9d51 (T1.3 alerts), 772db07 (T1.1 cron runner), 52d73b3 (T1.4 memory consolidation).
- Open follow-up (T2.3 found): GatewayManager.sendApproval never calls bridge.recordDelivery, so
  deliveredTo is empty and reactions cannot find the card → fix after T2.2 lands (same file).
- In flight: T2.2 double-texting, T1.2 heartbeat (+doctor cron path fix), T3.1 policy rules,
  T3.2 prompt redaction, T3.4 signed audit export. Five agents.
- Committed: 4b415dc (T2.2 double-texting + T2.3 manager hunk), d5d2c95 (deliveredTo recorded so
  reactions resolve), 0e49dc4 (T3.2 redaction; a literal NUL byte in redact.ts replaced by a
  unicode escape so git stops treating it as binary), 952e9b2 (T2.1 threads=sessions +
  configManager passed in gateway start), e09f054 (T3.1 policy rules), 2beb36f (T3.4 audit export).
- Shared-file staging: schema.ts/defaults.ts/index.ts hunks are staged per task by rewriting the
  HEAD version with only that task's lines (scratchpad helper) so each commit typechecks alone.
- Known limits recorded by agents: seat turns via apps/web executeSeatModel bypass core redaction
  (docs/security.md says so); audit export needs a Prisma-backed store (StorePort has no
  listAuditRows - follow-up); Ctrl+C on gateway start pre-empted by index.ts process.exit.
- docs/security.md + docs/configuration.md carry several tasks' sections uncommitted; they go in
  one docs commit after T1.2 lands.
- In flight: T1.2 heartbeat, T2.4 ask_human, T3.3 MCP scan/scrub, T3.5 run cap + jobs.
- Committed: 1f1de3f (T1.2 heartbeat + doctor cron path), 99b93ca (docs), fd980b5 (T3.3 MCP scan/
  scrub), 3b8f7c7 (T4.3 memory blocks; headless passes config.memory.blocks), 7d318fc (T3.5 run
  cap + jobs; amended twice: T2.4's in-flight orchestrator/index.ts hunks had leaked in, rebuilt a
  T3.5-only version in a scratch repo and verified HEAD typechecks + builds with T2.4 files held out).
- Lesson: two agents on one file (orchestrator/index.ts) means whole-file staging leaks the other
  task. From here, verify HEAD in isolation (stash + hold untracked) before every commit that
  touches a file another agent owns.
- Milestones 0, 1, 3 complete. 2 needs T2.4 (in flight). 4: T4.3 done, T4.1+T4.2 in flight.
  5: T5.1 in flight (apps/web).
- Follow-ups noted by agents, not yet done: StorePort.listAuditRows (audit export on SQLite
  store); JobRunRecord.metadata (jobs retry by id on SQLite); mcp_flagged lives at a passthrough
  key because McpServerCommonSchema strips unknown keys; consolidate.ts stays on the two default
  blocks; Ctrl+C on gateway start (index.ts process.exit).
- Committed 459a04b (T2.4 ask_human; I added 'human' to the blank-slate disabled list + test). Milestone 2 complete. In flight: T4.1+T4.2, T5.1; T5.2 after T5.1.
- Committed cb8660f (T5.1 apps/web goal/cycle/task links; apps/web 2760 pass), dfaa66f (T4.1+T4.2 in one commit: fleet-versions.ts carries both; REPL fixture updated for default 'human' toolset). Milestone 4 complete. In flight: T5.2 webhooks (apps/web), follow-ups agent (listAuditRows, JobRunRecord.metadata, mcp flagged on entry, README index).
- Committed 42b620d (T5.2 webhooks; apps/web 2792 pass), 2dd6d12 (two more defects registered in
  AGENTS.md: worker allowlist, Stripe middleware bypass), 3276079 (follow-ups: listAuditRows,
  JobRunRecord.metadata, mcp flagged on entry, README index).

## Evidence — clean worktree of HEAD 3276079 (git worktree add --detach; node_modules symlinked;
## prisma generate for both schemas as ci.yml does)
- `npx tsc --noEmit -p apps/cli/tsconfig.json` -> exit 0
- `npm --prefix packages/trent-core run build` -> exit 0
- `node scripts/ci/repo-scan.mjs` -> exit 0
- `npx vitest run` -> 180 files passed / 2 skipped; 1764 passed / 28 skipped (baseline 1306/27)
- `cd apps/web && npm test` -> 514 files passed / 13 skipped; 2792 passed / 125 skipped (baseline 2743)
- `cd apps/web && npm run typecheck` -> exit 0
- Note: before `prisma generate` the worktree typecheck failed on the generated client (gitignored);
  CI generates it, so this is not a defect in HEAD.

## Left open (recorded, not built)
- Seat turns go through apps/web executeSeatModel and bypass core prompt redaction (T3.2 limit).
- consolidate.ts works on the two default memory blocks only, not configured extra blocks.
- Ctrl+C on `gateway start` is pre-empted by apps/cli/src/index.ts's synchronous process.exit
  (SIGTERM/SIGHUP release cleanly).
- GatewayManager.sendApproval still titles question cards "Approval needed".
- Migrations 20260915120000 and 20260915180000 were generated with `prisma migrate diff` and not
  applied to any database (none reachable here).
- Live platform runs (Telegram/Slack/...) still skip without credentials, as before.
- Pre-existing apps/web defects 1-7 in AGENTS.md remain unfixed by design.
