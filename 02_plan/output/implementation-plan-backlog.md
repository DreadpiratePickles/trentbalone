# Backlog implementation plan — executes `feature-backlog-decision.md`

Approved by Bobby 2026-09-15 ("go ahead and make an implementation plan and then implement it").
Phase 5 decision delegated to the orchestrator: **option B+** — 5.1 ships as the bug fix it is (own
commit, own test, migration), then 5.2 under the same rules, both after phases 0–4.

Baseline: `c09927f` on `feature/trent-fleet-v2`, CI fully green. Rules: `AGENTS.md`,
`03_implementation/CONTEXT.md`, the rulebook §11/§13. Every task: RED first, exact commands and exit
codes, explicit-file staging, one hypothesis per commit, no push beyond the feature branch.

## Gates (run per task; the ones that apply)
```bash
npx vitest run                                   # core + cli (1306 pass / 27 skip at baseline)
npx tsc --noEmit -p apps/cli/tsconfig.json       # cli typecheck
npm --prefix packages/trent-core run build       # core typecheck
node scripts/ci/repo-scan.mjs                    # canned 0 / hex 0 / emoji 0
cd apps/web && npm test                          # ONLY for tasks touching apps/web (2743 tests)
```
Files stay under 500 lines. Agents edit with `Edit`, never overwrite an existing file with `Write`.
Agents do not commit; the orchestrator verifies and commits explicit paths per task.

## Execution shape
Waves of at most 6 Opus agents with disjoint file ownership. Shared files (`config/schema.ts`,
`commands/registry.ts`, `repl/index.ts`, `servers.ts`) are touched by one agent per wave.

---

# Milestone 0 — Truth

## T0.0 Extract the headless session runtime (prerequisite for 0.1, 0.2, 1.x, 2.x)
**Why:** `apps/cli/src/repl/index.ts:140-215` builds store → tools → fleet memory → improve →
orchestrator inline. The gateway handler, cron runner and heartbeat need the same object graph
without a terminal.
- **Create** `apps/cli/src/runtime/headless.ts` exporting
  `createHeadlessRuntime(deps): Promise<HeadlessRuntime>` with
  `{ orchestrator, companyId, store, durable, tools, fleetMemory, improve, run(objective, {trigger, signal}), cleanup() }`.
  `deps` = the subset of `ReplSessionDeps` the REPL already accepts (configManager, workspace,
  createOrchestrator, buildAdapters, startEgress, probeDocker, openStore).
- **RED** `apps/cli/src/runtime/headless.test.ts`: with a fake `createOrchestrator` and a fake
  store, `run("hello")` yields the fake's events and `cleanup()` calls `tools.cleanup`. Expected
  failure: module not found.
- **Then** make `repl/index.ts` call it (behaviour unchanged). Existing REPL tests must pass unchanged.
- **Verify:** `npx vitest run apps/cli` exit 0; tsc clean.
- **Commit:** `refactor(cli): headless session runtime shared by REPL, gateway and schedulers`

## T0.1 `gateway start` dispatches chat messages to the agent
**Defect:** `servers.ts:186` builds `GatewayManager` without `setAgentHandler`; `handleInbound:216`
returns silently. `docs/gateway.md` claims dispatch.
- **Create** `apps/cli/src/gateway/agent-handler.ts`: `createAgentHandler(runtime): AgentHandler` —
  runs `runtime.run(message.text, { trigger: "manual" })`, collects `consolidate_end`/`run_done`
  summary, returns it (or a short failure line on `run_failed`). No canned strings: the reply is
  the run's consolidated summary.
- **RED** `apps/cli/src/gateway/agent-handler.test.ts`: fake runtime emitting `run_done` with a
  summary → handler returns that summary. Then in `apps/cli/src/commands/__tests__/` a test that
  `gateway start` constructs the manager with an agent handler (spy on `setAgentHandler` or inject
  via `GatewayManagerOptions.agentHandler`). Expected failure: handler undefined.
- **Edit** `servers.ts` `start`: build runtime via T0.0, pass `agentHandler`, cleanup on exit.
- **Verify:** vitest + tsc. Update `docs/gateway.md` "What does work" to match.
- **Commit:** `fix(cli): gateway start installs the agent handler so chat messages reach a seat`

## T0.2 A chat approval resumes the paused run
**Defect:** `ApprovalRow` (GatewayStore.ts:47) has no `runId/stepId`; nothing links
`run_awaiting_approval` → `sendApproval`, or `approval_decided` → `orchestrator.approve`.
- **Edit** `GatewayStore.ts`: `ApprovalRow.runId?: string; stepId?: string`.
- **Create** `packages/trent-core/src/gateway/RunApprovalLink.ts`: `linkRunApprovals({ bus, bridge, manager, owner })` —
  on `run_awaiting_approval`/`step_awaiting_approval` create the request with `runId/stepId` and
  `sendApproval` to `gateway.owner`; on bridge `approval_decided` call `target.approve/reject(runId, stepId)`.
  Dedupe per (runId, stepId) as `ReplEngine:90` does.
- **Edit** `config/schema.ts`: `GatewayConfigSchema.owner?: { platform, channelId }`.
- **RED** `RunApprovalLink.test.ts`: fake bus emits `run_awaiting_approval` → manager.sendApproval
  called with a row carrying runId; `resolveCallback` approve → `approve(runId, stepId)` called once.
  Expected failure: module not found.
- **Edit** `servers.ts` `start`: wire the link with the runtime's orchestrator.
- **Commit:** `feat(gateway): approval decisions from chat resume the parked run`

## T0.3 Register the `cron` command group (honest until the runner exists)
- **Create** `apps/cli/src/commands/groups/cron.ts`: `list | add | pause | resume | remove | run`
  over `<profile>/cron/jobs.json` via the existing adapter functions (export what `tools/cron`
  needs; do not duplicate the file format). `run` returns a `TrentError` "cron runner not started —
  run `trent cron start`" until T1.1 lands, with exit code 3.
- **RED** `commands/__tests__/cron.test.ts`: `cron list --json` on an empty profile returns `{ jobs: [] }`.
  Expected failure: unknown command.
- **Edit** `commands/registry.ts` to register. Fix `docs/doctor.md:189`.
- **Commit:** `feat(cli): cron command group over the cron toolset's jobs.json`

## T0.4 OTel exporter constructed from config, with run→step→tool span hierarchy
- **Edit** `config/schema.ts`: `telemetry: { otlp_endpoint?: string, service_name: "trent" }` (new
  `TelemetryConfigSchema` in `config/telemetry-schema.ts`, one import line in schema.ts).
- **Edit** `traces/OTelExporter.ts`: spans carry `parentSpanId`; one run span, child step spans,
  child tool spans from `step_output` tool call records.
- **Create** `traces/bus-hook.ts`: `createOTelBusHook(exporter): RunBusHook` (same shape as
  `improve/trace-writer.ts` `BusHook`).
- **Create** `doctor/checks/telemetry.ts`: probes the endpoint with a HEAD/empty POST, reports
  `not configured` when unset (a skipped check is not a pass — say so in the line).
- **Edit** `apps/cli/src/runtime/headless.ts` (after T0.0): attach the hook when configured.
- **RED** `traces/bus-hook.test.ts`: a run with one step and one tool call yields three spans with
  correct parent ids, posted to a local HTTP server. Expected failure: module not found.
- Fix the banner in `slash/index.ts:411` to state the endpoint or "tracing off".
- **Commit:** `feat(traces): OTel export wired from config with run/step/tool span hierarchy`

## T0.5 Remove the voice transcription stub
`voice/WhisperProcess.ts:53` returns `"Transcribed N bytes of audio"`.
- Delete `voice/` stub code and the `voice` toolset/config flag that only it justified. If another
  module imports it, replace with a `TrentError("voice is not implemented in this release")`
  at the single entry point — an error, never a string that looks like output.
- **RED**: the test asserting the stub's string is deleted (a test that asserts a canned string is
  not a test — AGENTS.md 4); add a test that calling voice raises the error.
- Update `docs/` mentions. **Commit:** `fix(core): remove the voice transcription stub`

## T0.6 Drop mock `ssh`/`e2b` terminal backends from the schema
- **Edit** `terminal/`: delete `SSHBackend.ts`, `E2BBackend.ts` and their mock tests.
- **Edit** `config/schema.ts` `TerminalBackendSchema = z.enum(["docker","local"])`; bump
  `CONFIG_SCHEMA_VERSION` to 3; **Edit** `config/migrate.ts`: `ssh|e2b → docker` with a warning.
- **RED** `config/migrate.test.ts`: v2 config with `terminal.backend: "ssh"` migrates to v3 docker.
- Update `docs/terminal.md`, `docs/configuration.md`.
- **Commit:** `fix(core): terminal backends are docker and local; ssh/e2b mocks removed`

## T0.7 IdempotencyManager backed by disk and used at tool dispatch
- **Edit** `governance/IdempotencyManager.ts`: persistence via the same temp-then-rename JSON
  pattern as `GatewayStore` at `<profile>/idempotency.json`; key = `(runId, stepId, tool, sha256(args))`;
  TTL; dead-letter list persisted.
- **Find** the single dispatch point where a seat's tool call reaches an adapter
  (`orchestrator/seat-wiring.ts` / `tools/`), and wrap calls whose adapter scope is a side-effect
  scope (`write`, `execute`, `send`, `network`) in `executeWithIdempotency`. Read-only scopes bypass.
- **RED** `IdempotencyManager.test.ts`: same key twice across two manager instances (simulated
  restart) executes once; a read-scope tool is never recorded.
- **Commit:** `feat(governance): durable idempotency for side-effecting tool calls`

## T0.9 `backup-health.ts` restore script path (apps/web, invariant-1 exception)
- **RED** `apps/web/lib/backup-health.test.ts`: `simulateRestore` resolves the script path that
  exists under `scripts/backup/`. Expected failure: `pg-restore-test.sh` not found.
- One-line fix. `cd apps/web && npm test` exit 0.
- **Commit:** `fix(web): backup-health points at pg-restore-drill.sh, the script that exists`

## T0.10 + T0.11 Docs and known-defect register
- `docs/security.md:190`: approval floors are built (`tools/approval-floors.ts`).
- `AGENTS.md` known defects: add #5 `CompanyMember.permissions`/`Agent.permissions` never read
  (`session.ts:75` hardcodes `["*"]`); #6 `outbound/sequences.ts` returns `steps[0]`.
- **Commit:** `docs: security.md matches approval-floors; two more known defects registered`

---

# Milestone 1 — Overnight autonomy

## T1.1 Cron runner with run history and gateway delivery
- **Create** `packages/trent-core/src/cron/next-run.ts`: 5-field cron → next Date (UTC), tested
  against a table (every minute, `0 9 * * 1-5`, `*/15`, month rollover, DST-free UTC).
- **Create** `packages/trent-core/src/cron/CronRunner.ts`: reads `jobs.json`, ticks every 30s,
  launches each due job once (persists `lastRunAt`/`nextRunAt` before launch so a crash mid-run
  never double-fires), runs `runtime.run(prompt, { trigger: "scheduled" })` in a fresh session,
  appends `{ startedAt, endedAt, status, summary, costCents }` to `<profile>/cron/runs/<jobId>.jsonl`
  capped at 50, delivers `summary` to `deliver` (`telegram:<chat>` / `slack:#chan`) via `GatewayManager.send`.
- **Edit** `tools/cron/index.ts`: `RUNNER_NOTE` becomes conditional — present only when no runner
  is registered for the profile (a lock file `<profile>/cron/runner.lock` with pid).
- **Edit** `commands/groups/cron.ts`: `start` (keepAlive), `runs <jobId> [--last N]`, `run` executes now.
- **RED** `CronRunner.test.ts`: fake clock, one due job → one launch; tick again → zero; history
  row appended; delivery called; crash between persist and launch → not re-fired on restart.
- **Commit:** `feat(cron): runner that ticks jobs.json, keeps run history and delivers through the gateway`

## T1.2 Heartbeat loop with `HEARTBEAT.md`, NO_REPLY and quiet hours
- **Create** `packages/trent-core/src/heartbeat/` : `quiet-hours.ts` (port of
  `apps/web/lib/supervision/quiet-hours.ts` semantics via wrapper import if the wrapping matrix
  allows, else a 30-line reimplementation with the same test table), `HeartbeatLoop.ts`:
  interval from `heartbeat.interval_minutes` (default 60), `heartbeat.active_hours {start,end,tz}`,
  objective = `HEARTBEAT.md` + fleet state (pending approvals, budget, last cron runs, last run
  summary) + the contract "answer exactly `NO_REPLY` if nothing needs the founder"; `trigger: "heartbeat"`;
  non-NO_REPLY output → gateway DM to `gateway.owner`; every turn logged to `<profile>/heartbeat/runs.jsonl`.
- **Edit** `setup/`: write a default `HEARTBEAT.md` (checklist: approvals waiting, budget > 80%,
  failed runs, stale memory) on profile creation.
- **Edit** `config/schema.ts`: `HeartbeatConfigSchema`. **Edit** `commands/groups/cron.ts` or new
  `heartbeat.ts` group: `heartbeat start|status|runs`. `gateway start` runs it too when enabled.
- **RED** `HeartbeatLoop.test.ts`: inside quiet hours → no model call; `NO_REPLY` → no send, row
  logged; text → one send. Fake runtime + fake manager.
- **Commit:** `feat(heartbeat): HEARTBEAT.md loop with quiet hours and NO_REPLY delivered by DM`

## T1.3 Push alerts through the gateway
- **Create** `packages/trent-core/src/gateway/alerts.ts`: `createAlertHook({ manager, owner, budget, thresholds })`
  as a `RunBusHook`: `run_failed` → DM; `run_awaiting_approval` older than `alerts.approval_wait_minutes`
  (default 30) → one reminder DM; budget ledger crossing `alert_thresholds` → DM once per threshold.
- **RED** `alerts.test.ts`: each condition sends exactly once; no owner configured → no send and
  one structured log line.
- Wire in `headless.ts`. **Commit:** `feat(gateway): push alerts for failures, waiting approvals and budget thresholds`

## T1.4 Sleep-time memory consolidation
- **Create** `packages/trent-core/src/fleet-memory/consolidate.ts`: one model turn over MEMORY.md +
  USER.md producing a proposed rewrite within the caps; stored through the improve ledger as a
  draft `kind: "memory"` (extend `SkillDraftRow.kind`), promoted by the same `promoteDraft` path
  (atomic write via `tools/memory` commit), rollback via the ledger.
- Scheduled by `HeartbeatLoop` once per day inside quiet hours (`heartbeat.consolidate_memory: true`).
- **RED** `consolidate.test.ts`: fake gateway returns a shorter block → draft row created; promote
  writes the file atomically; rollback restores the previous bytes; output over the cap is rejected.
- **Commit:** `feat(memory): nightly consolidation drafts through the improve ledger`

---

# Milestone 2 — Conversation model

## T2.1 Threads are sessions
- **Edit** `GatewayStore.ts`: `conversations: Record<"platform:chat:thread", sessionId>`.
- **Edit** `apps/cli/src/gateway/agent-handler.ts`: resolve/create the session by key and run with
  `SessionManager` continuity (the `--continue` path).
- **RED**: two messages in the same thread share a session id; a new thread gets a new one.
- **Commit:** `feat(gateway): a chat thread maps to one session`

## T2.2 Double-texting policy
- **Create** `packages/trent-core/src/gateway/ConversationQueue.ts`: per-conversation serial queue;
  policy `enqueue | interrupt | reject` from `gateway.double_text_policy` (default enqueue);
  `/stop` → interrupt regardless.
- **Edit** `GatewayManager.handleInbound`: route through the queue.
- **Edit** `apps/cli/src/repl/engine.ts:201`: replace the silent drop with the same three modes
  (`repl.double_text_policy`), reusing `InterruptController` for interrupt.
- **RED**: enqueue runs second after first; interrupt aborts first (signal aborted) and runs second;
  reject replies with a one-line refusal from config, not a canned model reply.
- **Commit:** `feat(gateway,repl): explicit double-texting policy instead of dropping input`

## T2.3 Reactions as approvals (Slack, Discord, Telegram)
- **Edit** the three adapters: inbound reaction events → `InboundReaction { platform, channelId, messageId, emoji, senderId }`.
- **Edit** `ApprovalBridge`: `resolveReaction(reaction)` looks up the row by `deliveredTo.messageId`,
  maps 👍/✅ → approve, 👎/❌ → deny, through the same nonce/pending/admin checks.
- **RED** wire tests per platform + bridge test: reaction from unpaired sender rejected.
- **Commit:** `feat(gateway): reactions on the approval card decide it`

## T2.4 `ask_human` tool
- **Create** `packages/trent-core/src/tools/human/index.ts`: `ask_human(question, context, options?)`.
  In a run: parks the step like an approval (reuse the awaiting-approval mechanics with
  `kind: "question"` on `ApprovalRow`), delivered by DM through `RunApprovalLink`; the reply text is
  the tool result. In the REPL: a blocking prompt. In a delegated child: returns `blocked` (existing rule).
- **RED**: run pauses on `ask_human`; a chat reply resumes it with the text; child gets `blocked`.
- **Commit:** `feat(tools): ask_human hands a decision to the founder and waits`

---

# Milestone 3 — Trust

## T3.1 Trace-level policy rules over tool classes
- **Create** `governance/policy-rules.ts`: rule schema
  `{ effect: "deny"|"require_approval", when: Class, after?: Class, within?: number }`, classes
  derived from adapter scopes (`read`, `write`, `execute`, `send`, `network`, `secret`) plus the
  MCP class names; evaluator over the session's tool-call history; ~8 default rules
  (e.g. deny `send` after `secret` within 20 calls; require_approval `execute` after `network` fetch of a `.env`).
- Hook at the T0.7 dispatch point, before idempotency. Config `policy.rules` appends/overrides.
- **RED**: history [read_file(.env), send_message] → deny with rule id; same without the secret read → allow.
- **Commit:** `feat(governance): policy rules evaluated over the tool-call history`

## T3.2 Prompt-side redaction at the core model gateway
- **Create** `model-gateway/redact.ts` reusing `telemetry/redact.ts` detectors + configurable
  regexes (`privacy.redact_prompts: true`, `privacy.patterns[]`); applied to every outbound prompt
  and to OTel span attributes.
- **RED**: a prompt containing an API key and an email reaches the fake provider masked; disabled → verbatim.
- **Commit:** `feat(model-gateway): secret and PII redaction before the provider call`

## T3.3 MCP install-time scan and tool-output scrub
- **Edit** `commands/groups/mcp.ts` `add`: fetch tool list, run `skills/SecurityScan` over
  descriptions; findings → refuse unless `--allow-flagged`.
- **Edit** `tools/mcp/client.ts`: results pass through the redaction of T3.2.
- **RED**: a fake MCP server whose tool description contains an injection string is refused; a
  result containing a token is scrubbed.
- **Commit:** `feat(mcp): scan tool descriptions on add; scrub secrets from results`

## T3.4 Signed audit export
- **Create** `apps/cli/src/commands/groups/audit.ts`: `export [--out file]` writes NDJSON of the
  store's audit rows + `<file>.sig` (ed25519 over sha256 of the file, key at `<profile>/keys/audit.key`
  generated on first use, 0600), `verify <file>` checks the chain and the signature.
- **RED**: export → verify passes; flip one byte → verify fails with the row index.
- **Commit:** `feat(cli): signed audit export and verify`

## T3.5 Per-profile run cap and failed-jobs view
- **Edit** orchestrator drain loop: `runtime.max_concurrent_runs` (default 2) enforced.
- **Create** `commands/groups/jobs.ts`: `failed` lists failed JobRuns from the store, `retry <id>`.
- **RED**: third concurrent `run()` waits until one finishes; `jobs failed --json` lists a seeded failure.
- **Commit:** `feat(runtime): concurrent-run cap; trent jobs failed/retry`

---

# Milestone 4 — Fleet lifecycle

## T4.1 Agent versions with promote/rollback and run pinning
- **Create** `fleet/AgentVersions.ts`: immutable `{ agentId, version, promptHash, model, toolsets, skillsHash, label: "live"|"candidate", createdAt }`
  persisted through `StorePort` (extend with `agentVersions` like `SkillDraftRow`); `promote(agentId, version)`
  archives the previous live and writes an improve-ledger iteration so `rollback` reuses `lifecycle.ts:220`.
- Orchestrator run records `agentVersion` per seat at `run_start`; a promote during a run does not change it.
- **Edit** `commands/groups/fleet.ts`: `versions <id>`, `promote <id> <v>`, `rollback <id>`.
- **RED**: promote v2 while a run started on v1 → the run's seat still reports v1; rollback restores v1 live.
- **Commit:** `feat(fleet): versioned agent definitions with promote, rollback and run pinning`

## T4.2 Agent + skill export/import
- **Edit** `commands/groups/fleet.ts`: `export <id> <dir>` → `agent.json` + `skills/<slug>/SKILL.md`;
  `import <dir>` runs `SecurityScan` on every SKILL.md, refuses on findings.
- **RED**: export then import into a fresh profile yields an identical `agent.json` hash; a SKILL.md
  with an exfil pattern is refused.
- **Commit:** `feat(fleet): export and import an agent with its skills in SKILL.md layout`

## T4.3 Named memory blocks
- **Edit** `tools/memory/index.ts`: blocks from `memory.blocks[] {label, description, limit, read_only}`;
  defaults = today's MEMORY (2200) and USER (1375) plus `company` (1500, read_only for seats, writable by the founder/heartbeat).
- **RED**: a seat write to a read-only block is refused with the block label; prelude contains all
  three; existing memory tests pass unchanged.
- **Commit:** `feat(memory): named memory blocks with per-block limit and read_only`

---

# Milestone 5 — Work graph and hooks (apps/web; each its own commit with tests)

## T5.1 Connect Task ↔ Goal ↔ Cycle (bug fix: goal loop passes a goal id as a cycle id)
- **Edit** `apps/web/prisma/schema.prisma`: `Task.goalId?`, `Task.cycleId?`, `Task.blockedBy Task[] @relation("TaskBlocks")` / `blocks Task[]`, `Cycle.goalId?`. Migration via `prisma migrate dev --name task-goal-cycle-links`.
- **Edit** `goal-loop.ts:259`: create a real Cycle for the round, create Tasks with `goalId`, stop passing `goal.id`.
- **Edit** `goal-store.ts`: progress = done/total over linked tasks when any exist, else criteria.
- **RED** `goal-loop.test.ts`: a round creates a Cycle whose `goalId` is the goal and Tasks linked to both; `goal-store.test.ts` roll-up.
- **Verify:** `cd apps/web && npm test` exit 0, typecheck, derived SQLite schema test in core still passes.
- **Commit:** `fix(web): goal rounds create real cycles and tasks linked to the goal`

## T5.2 Outbound webhooks that deliver, and one inbound trigger
- **Edit** schema: `Webhook { id, companyId, url, secret, events[], enabled, failures }`, `WebhookDelivery { id, webhookId, event, payloadHash, status, attempts, lastError }`.
- **Create** `lib/webhooks.ts`: subscriber on `job-events`, HMAC-SHA256 `x-trent-signature` +
  `x-trent-timestamp`, retry with backoff via the existing queue, disable after 10 consecutive failures.
- **Create** `app/api/hooks/[id]/route.ts`: bearer secret, idempotency by `x-trent-idempotency-key`,
  creates a Task or launches a run per the webhook's `action`.
- **RED** per rulebook §11: signature, replay, idempotency, malformed body, unsupported event.
- **Commit:** `feat(web): outbound webhooks with signed delivery and an inbound trigger`

---

## Non-goals (preserved behaviour)
No new dependencies without a stated need. No change to `apps/web` outside T0.9, T5.1, T5.2. No
push beyond `feature/trent-fleet-v2`. No release. Voice, SSH/E2B backends are removed, not
reimplemented. Nothing in §5 of the decision doc.
