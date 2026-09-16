# Feature backlog decision — what Trent adds from the peer research, and what it refuses

Date: 2026-09-15. Input: the ~90-item backlog from the ever-gauzy / ERP-PM / agent-platform peer
survey (`~/Downloads/trent-todo.txt`). Evidence: five code audits in `02_plan/output/audit/`, one
per cluster, every claim tied to a file and symbol. Status: PROPOSED — needs Bobby's approval on
the one fork in §6 before phase 5 starts; phases 0–4 need no new authorization.

## 1. The one-paragraph verdict

The research was written against a survey of `apps/web` alone. Against the real tree — `apps/web`
+ `packages/trent-core` + `apps/cli` — **of the 74 items audited, 8 exist outright, 49 are partial, and 17
are absent**, and most of the absent ones are the wrong product (bank feeds, payroll,
SAML, Gantt). What Trent actually lacks is not features but *closed loops*: the CLI cron tool has no
runner, the OTel exporter is never constructed, `gateway start` never installs an agent handler so
chat messages are dropped, `quiet-hours.ts` has no importers, `IdempotencyManager` is exported and
never called. So the plan is ordered as: **(0) make what exists true, (1) overnight autonomy, (2) the
chat conversation model, (3) trust, (4) fleet lifecycle, (5) the work graph.** Everything in the
research that is an ERP/PM/CRM/HR feature is refused, with the reason recorded, so nobody re-litigates
it next month.

Selection rule used throughout: **include only if it (a) serves a solo founder running nine seats
on a cheap model overnight, (b) does not duplicate a module that already exists, and (c) can be
built in `packages/trent-core` or `apps/cli` without violating the `apps/web` read-only invariant**
(AGENTS.md invariant 1). Where (c) fails, the item goes to §6.

## 2. Phase 0 — Truth: things that claim to work and don't (do these first, all small)

These are not features. Each is a place where a doc, banner, or export promises behaviour the code
doesn't deliver — the exact failure mode AGENTS.md invariant 2 and 5 forbid. None needs design.

| # | Defect | Where | Fix |
|---|---|---|---|
| 0.1 | `gateway start` constructs `GatewayManager` without `setAgentHandler`; every non-approval chat message is silently dropped. `docs/gateway.md` says messages are "dispatched to the designated agent's context". | `apps/cli/src/commands/groups/servers.ts:186` | Wire the handler to the REPL session engine (same path `bindApprovalAnswers` uses, `apps/cli/src/repl/engine.ts:67`). Test: a wire-test Telegram message produces a model call. |
| 0.2 | Chat approval decision never resumes the paused run: gateway `ApprovalRow` carries no `runId/stepId`; nothing calls `orchestrator.approve` on `approval_decided`; nothing calls `createApprovalRequest` on `run_awaiting_approval`. | `packages/trent-core/src/gateway/ApprovalBridge.ts`, `GatewayManager.ts:184` | Add `runId/stepId` to the row, subscribe the bridge to `run_awaiting_approval`, resume on decision. Test: run pauses → Telegram button → run completes. This is the research's #1 item; it is one wire, not a feature. |
| 0.3 | `trent cron` is not a registered command and the cron tool's own header says "Nothing here ticks". `docs/doctor.md:189` admits it. | `packages/trent-core/src/tools/cron/index.ts`, `apps/cli/src/commands` | Phase 1 builds the runner; phase 0 just registers the group and makes `cronjob_manage` refuse `run` with an honest error until then. |
| 0.4 | `OTelExporter` is complete, tested, and never instantiated. The slash banner (`apps/cli/src/slash/index.ts:411`) advertises tracing. | `packages/trent-core/src/traces/OTelExporter.ts` | Construct it from config (`telemetry.otlp_endpoint`), attach to the orchestrator bus next to `trace-writer.ts`. Doctor check: endpoint reachable. |
| 0.5 | `voice/WhisperProcess.ts:53 transcribe()` returns the string `"Transcribed N bytes of audio"`. That is a canned response. | `packages/trent-core/src/voice/` | Remove the stub and the `tts_enabled` flag it justifies, or gate the toolset off with an "unimplemented" doctor line. Real voice is refused for now (§5). |
| 0.6 | CLI `ssh` and `e2b` terminal backends return mock strings (`terminal/SSHBackend.ts:26`); `config/schema.ts:34` still offers them. | `packages/trent-core/src/terminal/` | Drop them from the schema enum until real (design doc §6 already says "rebuild"). A config option that lies is worse than none. |
| 0.7 | `IdempotencyManager` is in-memory and unwired; design doc §6 already ruled "a guard that forgets on restart is not a guard". | `packages/trent-core/src/governance/` | Either back it with the SQLite store and call it from the external-write tool path, or delete it. Recommend: back it, call it from `tools/` for `money_moving`/`destructive` classes. |
| 0.8 | `supervision/quiet-hours.ts evaluateQuietHours` has zero importers. | `apps/web/lib/supervision/quiet-hours.ts` | Consumed by phase 1 heartbeat. Nothing to do now except stop describing it as a feature. |
| 0.9 | `backup-health.ts:21` shells out to `pg-restore-test.sh`; the script is `pg-restore-drill.sh`. `simulateRestore` cannot pass outside tests. | `apps/web/lib/backup-health.ts` | One-line fix. Qualifies as the invariant-1 exception (own commit, own test). |
| 0.10 | `docs/security.md:190` lists "approval floors over deobfuscated variants" as not built; `tools/approval-floors.ts` builds and tests exactly that. | docs | Fix the doc. |
| 0.11 | `CompanyMember.permissions` and `Agent.permissions` Json columns are never read; `session.ts:75` hardcodes `["*"]`. | `apps/web/lib/session.ts` | Record as a known defect next to the four in AGENTS.md. Not fixed on this branch (see §5 on roles). |
| 0.12 | `outbound/sequences.ts nextSequenceStep` returns `steps[0]` regardless of the matched step. | `apps/web/lib/outbound/` | Record only. `outbound/` is refused in §5; don't polish it. |

## 3. Included — new work, by phase

Each item names what it builds on so nobody rebuilds it. "Owner" is the package that changes.

### Phase 1 — Overnight autonomy (the strategy doc's "production heartbeat wiring" gap)

| # | Feature | Builds on (exists) | What is actually new | Owner |
|---|---|---|---|---|
| 1.1 | **Cron runner** with per-job run history (`last N runs`), pause/resume, and a `deliver:` target that goes through the gateway | `tools/cron/index.ts` (full CRUD, cron validation, prompt-injection scan, approval when terminal enabled); `schedule-grammar.ts` (NL + cron); `JobRun` | A ticking loop in the CLI process (`trent cron start` / inside `gateway start`), a per-job runs table in the SQLite store, isolated session per run, delivery via `GatewayManager.send`. | core + cli |
| 1.2 | **Heartbeat loop, Hermes/OpenClaw shape**: a user-editable `HEARTBEAT.md` checklist per profile, fixed interval, one bounded agent turn, `NO_REPLY` contract, quiet window, owner DM | `heartbeat.ts` (skip/monitor/act decision, hard-coded rules); `quiet-hours.ts` (unused); `autonomy-scheduler.ts`; `morning-briefing-email.ts` | The checklist becomes a file the founder edits; the decision is a real model turn over that file plus fleet state, not a rule table; `monitor` maps to `NO_REPLY`; delivery is a gateway DM (Telegram/Slack), email stays as fallback. Reuses 1.1's runner as the tick. | core + cli |
| 1.3 | **Push alerts through the gateway** for the events that already fire: spend soft-warn/hard-stop, approval pending > N min, run failed, heartbeat `act` | `spend.ts softWarn/hardStop`; `scheduler.ts processExpiredApprovals`; gateway `MessageQueue` (durable, circuit-broken) | A small subscriber: orchestrator/spend event → gateway DM. Closes the "no push alerting" gap in audit C.2 with ~one file. | core |
| 1.4 | **Sleep-time memory consolidation**: a heartbeat-scheduled job in the quiet window that dedupes and summarises `MEMORY.md`/`USER.md`, writing a diff the founder can see next morning | `tools/memory` (capped blocks, atomic commit); `runSelfImprovementSweep` (skills/GEPA only); `improve/meter.ts` (budget) | The memory target. Skills already consolidate; memory doesn't. Output goes through the same quarantine→promote ledger as skill drafts so it is rollback-able. | core |

### Phase 2 — The conversation model (make chat a first-class surface, not a notifier)

| # | Feature | Builds on | New | Owner |
|---|---|---|---|---|
| 2.1 | **Threads = sessions** on every gateway platform that has threads; a reply in a thread resumes that session | `GatewayManager.handleInbound` passes `threadId`; `sessions/SessionStore` | A `(platform, chatId, threadId) → sessionId` map in the gateway store; `--continue` semantics for chat. | core |
| 2.2 | **Double-texting policy**, configurable: `enqueue` (default), `interrupt`, `reject` — per chat and in the REPL | REPL `if busy return` (drop); `InterruptController`; per-platform outbound queue | A per-conversation inbound queue with a policy switch; `/stop` maps to interrupt. The REPL gets the same three modes instead of silently dropping keystrokes. Rollback mode is refused (no state-edited fork, see §5). | core + cli |
| 2.3 | **Reactions as approvals** (👍/👎 on the approval message) where the platform supports inbound reactions (Slack, Discord, Telegram) | `ApprovalBridge` nonce+pending+admin checks; outbound `reactions.add` already used | Inbound reaction handlers routed through the same `resolveCallback`, so the forgery/replay guarantees hold. | core |
| 2.4 | **`ask_human` tool** — an agent hands a decision or task to the founder with structured context; it becomes a Task with a human owner, a gateway DM, and (in the REPL) a blocking prompt; delegated children get `blocked` as today | critic `escalate` → `addCeoMessage`; `Approval.taskId`; `TaskStatus waiting_approval/blocked`; the "children can't wait for humans" rule | The tool itself, a `humanOwner`/`dueAt` on the task row in the CLI store, and the reply path back into the run. This is the "human-as-tool" item and it fits the cofounder metaphor better than anything else on the list. | core |

### Phase 3 — Trust (cheap because the classification layer already exists)

| # | Feature | Builds on | New | Owner |
|---|---|---|---|---|
| 3.1 | **Trace-level policy rules**: rules over *policy classes* evaluated against the session's tool-call history before each call — e.g. `deny external_send after secret_access`, `require approval for destructive within 5 calls of read_file(*.env)` | `mcp-policy.ts` classes (`read_only`, `money_moving`, `destructive`, `secret_access`); `approval-floors.ts`; `external-action-guardrails.ts` (single-call pre/post) | A tiny rule schema in `governance/` + an evaluator over the in-session trace. Because rules are over classes, not tool names, ~10 default rules cover every toolset and every MCP server. Invariant-style guardrails are the one Invariant-Labs idea worth taking; the DSL is not. | core |
| 3.2 | **Prompt-side redaction** at the core model gateway (secrets + configurable PII patterns), opt-in per profile | `telemetry/redact.ts`; `credential-boundary.ts scrubSecrets`; `CredentialBroker` (egress) | One pass in `model-gateway` before the provider call, and the same pass before OTel export (0.4). Presidio is refused; regex + the existing secret detector is proportionate. | core |
| 3.3 | **MCP install-time scan + output scrub**: run `skills/SecurityScan.ts` over tool descriptions on `mcp add`, and `scrubSecrets` over tool results in the core adapter | drift hashing (`verifyMcpToolIntegrity`), egress SSRF checks, stdio env scrubbing | Two call sites. Signature verification of MCP servers is refused (no ecosystem standard yet). | core |
| 3.4 | **Signed audit export**: `trent audit export` emits NDJSON plus a detached signature over the chain head using the release signing key already in repo secrets | `verifyAuditChain`, `/audit/export` NDJSON, release signing keys | The signing step and a `verify` counterpart. | cli |
| 3.5 | **Per-company run cap + job priority; `trent jobs failed` DLQ view** | `ORC_MAX_CONCURRENCY` (per run), `JobRun`, `worker.on("failed")` logging | A `maxConcurrentRuns` per profile/company in the CLI drain loop, BullMQ `priority` in connected mode, and a CLI listing of failed JobRuns with `retry`. `readiness-controls.ts:367` already flags this as partial. | core + cli |

### Phase 4 — Fleet lifecycle (the strategy doc's "no versioned agent definitions" gap)

| # | Feature | Builds on | New | Owner |
|---|---|---|---|---|
| 4.1 | **Agent versions**: an immutable `AgentVersion {prompt hash, model policy, toolsets, skill set hash}` with labels `live`/`candidate`, `promote`/`rollback`, and in-flight runs pinned to the version they started on | `improve/lifecycle.ts promoteDraft/rollback` (prompts and skills already version, hash, and roll back); eval gate before promote; `fleet/AgentInstaller` `<id>.json` | The bundle object and the pin. This must *reuse* the improve ledger, not add a second promote path — one lifecycle for prompts, skills, and agents. | core |
| 4.2 | **Agent + skill export/import format**: `trent fleet export <id>` → a directory with `agent.json` + `SKILL.md` layout (the agentskills convention `docs/skills.md:96` says is not implemented) and `trent fleet import` | `AgentInstaller`, `skills/` loader + SecurityScan on import | The layout, the two commands, and the scan on import. Competitor-config importers (hermes/openclaw migrate) are refused for now. | cli |
| 4.3 | **N named memory blocks**: generalise the two capped blocks to `{label, description, limit, read_only}` declared in config; a shared read-only `company` block every seat reads, plus per-seat writable blocks | `tools/memory` (caps, readOnly, atomic commit, prelude injection); fleet-memory freeze/thaw | Config schema + loop over blocks instead of two constants. The research called this the cheapest differentiator; in this codebase it is a refactor, not a feature. | core |

### Phase 5 — The work graph and hooks (needs the §6 decision)

| # | Feature | Builds on | New | Owner |
|---|---|---|---|---|
| 5.1 | **Connect Task ↔ Goal ↔ Cycle** with foreign keys and `blocks/blockedBy` on Task, so goal progress rolls up from tasks instead of criteria counts and `goal-loop.ts:259` stops passing `goal.id` as a `cycleId` | `dependsOn` on plan steps; `goal-store` criteria; `RecurringTaskTemplate` | Three FKs and one self-relation in the Prisma schema, the goal-loop fix, a roll-up query. No Initiatives, no critical path, no custom fields, no Gantt. | web (schema) |
| 5.2 | **Outbound webhooks that actually deliver** (HMAC `x-trent-signature`, retry, per-endpoint enable) and one **generic inbound trigger** `POST /api/hooks/<id>` that creates a Task or starts a run | `createWebhookSurface` (advertises exactly this), `job-events.ts` bus, the Stripe/Resend inbound handlers, gateway `MessageQueue` (the delivery/retry pattern to copy) | A `Webhook` row, a subscriber on the bus, the inbound route. This replaces the "automation rules engine" item: cron (1.1) + hooks + the agent itself is the rules engine. | web |

## 4. Where each research "start here" item ended up

| Research rank | Item | Decision |
|---|---|---|
| 1 | Messaging gateway + button approvals | **Exists.** Gap is wire 0.2 + phase 2. |
| 2 | Cron + heartbeat with quiet hours | Phase 1 (1.1, 1.2). Cron CRUD and quiet-hours code exist; runner and wiring don't. |
| 3 | OTel export + per-trace cost rollups | 0.4 (exporter exists, never constructed); cost is already per step/run/goal/agent/company — only push alerts (1.3) are new. |
| 4 | Durable/idempotent workers | Web orchestrator is already durable and tested (`orchestrator-durable-run.test.ts:160`). 0.7 + 3.5 cover the remainder. Outbox refused (§5). |
| 5 | Versioned agent definitions | Phase 4.1, built on the improve ledger. |
| 6 | MCP OAuth/policy gateway | Policy exists. OAuth refused for now (§5). Scan/scrub in 3.3. |
| 7 | Custom roles agents obey | Refused (§5); dead column recorded (0.11). |
| 8 | Shared memory blocks | Phase 4.3 — a generalisation of what ships. |

## 5. Refused — with the reason, so it stays refused

**Wrong product.** Trent is a cofounder fleet for one founder, not an ERP. The finance seat tracks
spend and runway; it does not do bookkeeping. If a founder needs these, the answer is an MCP
connector to Midday/Bigcapital/ERPNext (Trent already speaks MCP both ways), never a rebuild:
bank feeds + receipt matching; client invoicing, payment links, dunning; chart of accounts, P&L,
balance sheet; multi-currency/FX/tax/e-invoicing; period locking; accountant export; native
CRM deals/pipelines/time-in-stage; mail/calendar continuous sync and shared inboxes; sequences,
SMS, telephony, WhatsApp beyond the gateway adapter that exists; HR/attendance/appraisals.
The `outbound/` planners that gesture at some of this stay as they are (bug 0.12 recorded).

**Wrong stage.** Solo founder, private repo, first release not yet cut: SSO/SAML/OIDC/SCIM/2FA;
custom roles and permission schemes (four ranks are enough until there is a second human;
`permissions` Json is recorded as dead); guest roles and client portals beyond the public page
that exists; GDPR export tooling; i18n; white-label; mobile app (the gateway *is* the mobile
surface — Telegram/WhatsApp on the founder's phone).

**Violates the read-only invariant for no proportionate gain.** Frontend plugin extension slots,
draggable dashboard widget host, Kanban/Gantt/calendar over tasks, saved views + query language
(PQL), custom fields, public roadmap/status page, retro/Lean Canvas/SWOT boards, a Workbench
step-debugger UI. All of these are `apps/web` UI work; the branch's contract is to wrap that app,
not extend it. Revisit only if the web app leaves read-only status.

**Contradicts the cheap-model philosophy.** 100+ subagent fan-out / autoresearch mode: the caps
(`DELEGATE_MAX_TASKS=6`, depth 2, `ORC_MAX_CONCURRENCY=4`) are deliberate budget controls, not
gaps. Benchmark-driven cost routing: refused until `evalScore` per model per task type has
accumulated for a few months; the eval infra to do it later exists.

**Over-engineered for the size.** Transactional outbox for BullMQ (deterministic job ids + DB
status already give at-least-once with dedupe; the gateway has a real outbox where it matters);
`IntegrationMap` table (no two write-adapters need it yet); automation rules engine with
versions (replaced by 5.2 + cron + the agent); Presidio-grade PII engine (3.2 is proportionate);
MCP server signature verification (no standard); per-end-user OAuth for tools and MCP servers
(one user); Notion/Linear/Jira importers; hermes/openclaw config migration (revisit at public
release when there is someone to migrate); multi-level approval chains with delegation (one
approver; expiry → re-plan already exists); time-travel fork with edited state; sandbox warm
pools and provider-native pause (workbench already checkpoints; CLI sandbox is Docker+egress and
stronger than the peers'); SLO dashboards per role (skill/tool health exists; a page is web UI);
red-team corpus in CI (worth doing after phase 3.1 lands, not before — record as P3); voice
STT/TTS/meeting bot (0.5 removes the stub; real voice is a milestone-7 item in the design doc
and stays there); device nodes.

## 6. The one fork Bobby has to call

Phase 5 changes the Prisma schema in `apps/web` (three FKs, a self-relation, a `Webhook` model,
one route). AGENTS.md invariant 1 allows `apps/web` changes only as a deliberate bug fix in its
own commit with a test. 5.1 can be argued as a bug fix (the goal loop passes a goal id as a cycle
id and persists artifacts instead of tasks); 5.2 cannot — it is a feature the surface descriptor
merely promised. Options:

- **A (recommended):** phases 0–4 proceed now under existing authorization; phase 5 waits for an
  explicit "yes, relax invariant 1 for these two commits". Nothing in 0–4 depends on 5.
- **B:** treat 5.1 as the bug fix it is, ship it in its own commit with the goal-loop test, and
  leave 5.2 for after the first release.
- **C:** drop phase 5 entirely; the CLI store gets its own task graph later.

Everything else in this document is buildable in `packages/trent-core` and `apps/cli` under the
rules already in force.

## 7. Order of work and evidence required

Phase 0 is a day of small commits, each with a failing test first (0.1, 0.2, 0.4, 0.7, 0.9 are
testable; 0.3, 0.5, 0.6, 0.10, 0.11, 0.12 are honesty edits). Phase 1 is the first real milestone
and its acceptance test is the one the strategy doc asked for: **a heartbeat runs overnight on a
schedule, respects quiet hours, sends nothing when there is nothing to say, and delivers one
Telegram DM in the morning — proven by the job's run history, not by a log line.** Phases 2–4 are
independent of each other and can run as parallel tracks after phase 1. Gate stays
`cd apps/web && npm test` plus `npx vitest run` in core/cli, and CI must stay green on every
commit — it is green on `7f405da` today and that is the baseline.
