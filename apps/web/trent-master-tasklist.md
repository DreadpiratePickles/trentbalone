# Trent — Master Task List

> Source of truth for executing the Trent roadmap from working prototype → production AI cofounder OS for solo founders & small teams.
> Format: Epic → Task → Sub-task. Tick boxes as you go.
> Last generated: 2026-05-26 · updated 2026-05-27 with Viktor-parity operating coworker epic · supersedes any earlier list.
> **Models:** OpenAI + Anthropic only. Local model work (Ollama / LM Studio / vLLM / on-prem) lives in `trent-local-models.md` — separate workstream.

**Legend**

- `- [ ]` open · `- [x]` done · `🔥` critical path · `🧪` requires eval gate · `🔒` security-sensitive · `💰` blocks paid GA · `🎤` GTM-visible

---

## E0 — Foundations & Project Setup

- [ ] **T0.1 — Repo & monorepo layout** 🔥
  - [ ] Decide monorepo tool (recommend: Turborepo + pnpm workspaces)
  - [ ] Create `apps/console` (Next.js 14, App Router)
  - [ ] Create `apps/worker` (Trigger.dev tasks)
  - [ ] Create `apps/api` (tRPC or REST gateway)
  - [ ] Create `packages/agents` (agent definitions, prompts, evals)
  - [ ] Create `packages/mcp` (MCP server implementations)
  - [ ] Create `packages/db` (Prisma schema, migrations)
  - [ ] Create `packages/memory` (memory tiers, retrieval)
  - [ ] Create `packages/orchestrator` (cycle engine wrappers)
  - [ ] Create `packages/ui` (shared shadcn/ui components — operator console kit)
  - [ ] Create `packages/eval` (eval harness, frozen sets, scoring)
  - [ ] Create `packages/types` (shared Zod schemas)
  - [ ] Add root `.tool-versions`, `.nvmrc`, `package.json` engines
  - [ ] Configure `turbo.json` pipelines: `build`, `dev`, `test`, `lint`, `typecheck`, `eval`
- [ ] **T0.2 — Dev environment**
  - [ ] Add `docker-compose.dev.yml` with Postgres 16, Redis 7, MinIO (S3-compatible)
  - [ ] Add `.env.example` documenting every required env var
  - [ ] Add `direnv` or `dotenv-cli` config so secrets never hit shell history
  - [ ] Write `scripts/bootstrap.sh` for one-command local setup
  - [ ] Add `scripts/seed.ts` for deterministic local data
- [ ] **T0.3 — CI/CD baseline**
  - [ ] Set up GitHub Actions: typecheck, lint, unit, integration, eval-on-PR
  - [ ] Add Vercel project for `apps/console` preview deploys per PR
  - [ ] Add Trigger.dev staging environment
  - [ ] Wire branch protection: required checks, code owner reviews
  - [ ] Add Renovate or Dependabot with weekly cadence
  - [ ] Add `release-please` for automated changelog + tagging
- [ ] **T0.4 — Observability spine**
  - [ ] Sign up for Sentry — wire frontend + backend
  - [ ] Sign up for OpenTelemetry collector → Grafana Cloud (or Honeycomb)
  - [ ] Wire `pino` structured logging with redaction for PII fields
  - [ ] Define standard log keys: `companyId`, `cycleId`, `agentId`, `toolName`, `traceId`
  - [x] Add health endpoints: `/api/health` (liveness + readiness, DB probe)
  - [ ] Stand up status page (BetterStack or Statuspage.io) 🎤
- [x] **T0.5 — Project hygiene**
  - [x] Write `README.md` (what is it, run it, deploy it, all env vars, API routes, stack)
  - [x] Write `CONTRIBUTING.md` with PR template, commit conventions (Conventional Commits)
  - [x] Add `CODEOWNERS`
  - [x] Add `SECURITY.md` (responsible disclosure)
  - [x] Add ADR (Architecture Decision Record) folder + first ADR: "Choice of durable execution engine"

---

## E1 — Architecture & Reasoning Core

- [ ] **T1.1 — Durable execution engine** 🔥
  - [ ] Final decision: Trigger.dev v3 (recommendation) vs Inngest vs Temporal
  - [ ] Spike: build a hello-world cycle on each finalist (1-day timebox)
  - [ ] Document trade-offs in ADR-002
  - [ ] Install chosen SDK in `apps/worker`
  - [ ] Implement `cycle.run({ companyId, agentId, trigger })` workflow stub
  - [ ] Add deterministic retry policy per tool category
  - [ ] Add cycle timeout policy (per agent, configurable)
  - [ ] Configure dead-letter queue with alert routing
  - [ ] Write integration test: kill worker mid-cycle, verify resume
- [ ] **T1.2 — Reasoning loop design**
  - [ ] Draft state-machine for a cycle: `idle → plan → step* → critic → commit | escalate → close`
  - [ ] Define `Plan` schema (Zod): goals, sub-tasks, expected tools, success criteria
  - [ ] Define `Step` schema: action, tool, input, output, verifier_pass, duration_ms, cost_usd
  - [ ] Implement planner → executor → critic three-call chain
  - [ ] Add max-step budget per cycle (configurable per agent)
  - [ ] Add token + dollar budget guard at planner stage
  - [ ] Add structured error escalation path → approval queue with reason
  - [ ] Write unit tests for each state transition
- [ ] **T1.3 — Model gateway** 🔥
  - [ ] Decision: LiteLLM proxy vs thin in-house gateway
  - [ ] Implement provider adapters: Anthropic, OpenAI (only — local models tracked separately in `trent-local-models.md`)
  - [ ] Add streaming pass-through
  - [ ] Add request signing + per-company request budget headers
  - [ ] Add fallback chain: primary → secondary → degraded (draft-only) mode
  - [ ] Add structured token + cost telemetry per call
  - [ ] Persist every model call in `model_call` table (input hash, output hash, cost, latency)
  - [ ] Unit test: provider outage triggers fallback within 2s
- [ ] **T1.4 — Per-agent model routing**
  - [ ] Define `AgentModelPolicy` table: `agent_id, role, primary_model, fallback_models, max_cost_per_call, temperature`
  - [ ] Seed policies: ST=Opus, EG=Sonnet+code variant, PM/FN/LG=Sonnet, MK/CS/GR=Sonnet+Haiku for classify, OT=Haiku
  - [ ] Add UI in admin panel to override routing per company
  - [ ] Add A/B routing capability (canary % per agent)
- [ ] **T1.5 — Structured output enforcement**
  - [ ] Wire `zod-to-json-schema` for tool schemas
  - [ ] Use Anthropic tool use + OpenAI structured outputs natively
  - [ ] Add validator that retries on schema violation (max 2 retries with feedback)
  - [ ] Reject any agent step that fails schema after retry → escalate

---

## E2 — Memory & RAG Stack

- [ ] **T2.1 — Database schema** 🔥 🔒
  - [ ] Provision Postgres 16 (Neon, Supabase, or RDS)
  - [ ] Install `pgvector` extension + `pg_trgm` for hybrid search
  - [ ] Design `companies` table: `id, owner_user_id, name, slug, created_at, settings_jsonb`
  - [ ] Design `users` table with WorkOS/Clerk integration ID
  - [ ] Design `company_members` join table with role enum
  - [ ] Design `cycles` table: `id, company_id, agent_id, started_at, ended_at, status, cost_usd, summary`
  - [ ] Design `cycle_steps` event log: append-only, JSONB, ordered
  - [ ] Design `memory_episodic` table: `id, company_id, cycle_id, agent_id, content_jsonb, ts`
  - [ ] Design `memory_semantic` table: `id, company_id, fact_type, content, embedding vector(1536), confidence, valid_from, valid_to, superseded_by, source_cycle_id`
  - [ ] Design `documents` table for ingested files: `id, company_id, source, mime, sha256, ingested_at`
  - [ ] Design `chunks` table: `id, document_id, content, embedding vector(1536), tokens, ord, metadata_jsonb`
  - [ ] Design `tool_calls` table: input, output, cost, latency, dry_run, approval_state
  - [ ] Design `approvals` table: `id, company_id, cycle_id, tool_call_id, requested_at, decided_at, decided_by, decision, reason`
  - [ ] Design `audit_log` table: append-only, signed rows, exportable
  - [ ] Design `credentials` table: per-company encrypted secrets, KMS key ref
  - [ ] Design `agent_runs` join + `agent_quality_scores` rollups
  - [ ] Write all Prisma migrations
  - [ ] Add database diagrams to `docs/architecture/db.md`
- [ ] **T2.2 — Multi-tenant isolation** 🔒 🔥
  - [x] Enable Postgres Row-Level Security on every tenant table (prisma/migrations/20260529000000_rls)
  - [x] Define `current_company_id` session var, set per request (lib/rls.ts withCompanyContext)
  - [x] Write RLS policies (SELECT/INSERT/UPDATE/DELETE) per table (tenant_isolation + service_bypass policies)
  - [x] Add integration test: application-layer assertCompanyMatch blocks cross-tenant access (lib/rls.test.ts)
  - [x] Add integration test: cross-tenant read attempts fail (assertCompanyMatch statusCode 403)
  - [x] Add integration test: cross-tenant write attempts fail (assertCompanyMatch COMPANY_MISMATCH code)
  - [ ] Add pgTAP tests for RLS policies
  - [ ] Document RLS contract in `docs/security/tenant-isolation.md`
- [ ] **T2.3 — Embeddings pipeline**
  - [ ] Pick embedding model (Voyage 3 or OpenAI text-embedding-3-large)
  - [ ] Wire embedding service with batching (32-64 at a time)
  - [ ] Add chunking strategy by content type (markdown headings, code blocks, ticket fields)
  - [ ] Add `unstructured.io` or custom parser for PDF/DOCX/HTML
  - [ ] Add async ingestion queue
  - [ ] Add deduplication by SHA256
  - [ ] Add re-embed job when model version changes
- [ ] **T2.4 — Hybrid retrieval** 🧪
  - [ ] Implement dense search via pgvector cosine
  - [ ] Implement BM25 via `pg_trgm` or `tsvector`
  - [ ] Implement Reciprocal Rank Fusion combiner
  - [ ] Integrate Voyage rerank-2 or Cohere Rerank 3 as second stage
  - [ ] Add metadata pre-filter (company, source, date range, owner)
  - [ ] Benchmark precision@5 / recall@20 on a held-out eval set
  - [ ] Document retrieval defaults per agent
- [ ] **T2.5 — Memory tiers**
  - [x] Implement `WorkingMemory` class: bounded, summarized at close
  - [x] Implement `EpisodicMemory` writer hooks at cycle close
  - [x] Implement `SemanticMemory` writer with `(fact_type, content, source)` extractor
  - [x] Add memory-correction flow: human edits in UI write back as authoritative (edit button on document results, PATCH /api/companies/[id]/memory)
  - [x] Implement `valid_from / valid_to` with supersedes chain
  - [x] Build memory search bar API endpoint
  - [x] Build memory inspector UI (Signature Moment M/06) 🎤
- [ ] **T2.6 — Query rewriting & decomposition** 🧪
  - [ ] Implement query-rewrite step before retrieval (handles pronouns + freshness)
  - [ ] Implement query decomposition for multi-hop questions
  - [ ] Eval set: 50 founder-style queries with ground truth
- [ ] **T2.7 — Freshness pipeline**
  - [ ] CDC source connectors: GitHub, Stripe, Gmail/Outlook, Slack
  - [ ] Define per-source max staleness SLA
  - [ ] Add staleness indicator in UI ("data as of 4m ago")

---

## E3 — Durable Runtime & Orchestration

- [x] **T3.1 — Scheduled cycles** 🔥
  - [x] Define schedule grammar (cron + natural "every morning")
  - [ ] Implement default cycle schedule per agent
  - [x] Add company-level cycle policy (paused, autonomy level) — company.status + autonomyLevel guard
  - [x] Add `next_run_at` view for ops — nextCycleAt shown in Settings controls
  - [x] Implement nightly autonomous run (competitor parity) 🎤 (nightlyRunHour field + scheduler logic)
  - [x] Implement morning briefing assembly + delivery (assembleMorningBriefing; auto-triggered after nightly cycles; manual trigger in Reports page; mocked email Phase 1)
- [x] **T3.2 — Live execution streaming**
  - [x] Server-Sent Events channel per cycle (`/api/jobs/events`)
  - [x] Wire frontend live indicator in TopBar and sidebar (EventSource in AppShell)
  - [x] Stream planner output, step start/end, tool I/O (plan_start/end + agent_start/end events via SSE)
  - [x] Add backpressure handling for long cycles
- [x] **T3.3 — Cycle replay (Signature Moment M/02)** 🎤
  - [x] Render event log as scrubbable timeline (proportional duration track + step list)
  - [x] Per-step drawer with full input/output, model version, tokens, cost, tool calls
  - [x] "Re-run from this step" button (debug only)
  - [x] Share-replay URL (gated by company member auth — ?cycle=xxx param + copy-link button)
- [x] **T3.4 — Kill switch (Signature Moment M/04)** 🔒 🎤
  - [x] `paused` status at company scope
  - [x] Worker checks flag at every state transition (re-fetches company status before each agent step)
  - [x] Visible toggle in console header (pause/resume button in TopBar)
  - [x] Keyboard shortcut `cmd+shift+.`
  - [x] Audit log entry on company status change (via updateCompany audit hook)
- [x] **T3.5 — Resource budgeting**
  - [x] Per-company weekly $ budget (weeklyBudgetCents field; Settings UI + Budgets page with rolling 7-day enforcement)
  - [x] Per-agent daily token budget (field on Agent; editable in Settings agents tab)
  - [x] Pre-flight check before any `SPENDS_MONEY` action (assertAgentTokenBudget + assertToolSpendAllowed; Meta Ads/Stripe/Postmark flagged)
  - [x] Soft-warn at 80%, hard-stop at 100%

---

## E4 — Agent Roster (9 + Strategist)

> Each agent gets the same checklist. Stamp the agent code and proceed.

- [x] **T4.0 — Shared agent scaffolding**
  - [x] Define `Agent` interface: `id, role, model_policy, tools, prompt_template, eval_set, quality_label`
  - [x] Write the canonical agent prompt template (operator vocabulary, brand voice, output contracts, safety stops)
  - [x] Implement quality label system: `experimental | supervised | autonomous`
  - [x] Surface quality label in UI next to agent name 🎤
- [ ] **T4.1 — PM (Product Manager) — autonomous-target**
  - [ ] Write role spec: backlog prioritization, spec drafting, loop-closing
  - [ ] Define toolset: read Linear/GitHub Issues, write specs, post comments
  - [ ] Write system prompt v1
  - [ ] Build frozen eval set: 30 cases (backlog re-prio, spec draft, dup detection)
  - [ ] Implement happy-path cycle test
  - [ ] Set quality label
- [ ] **T4.2 — EG (Engineer) — supervised-target** 🔥 🧪
  - [ ] Write role spec: repo read, patch draft, PR open, test run, never auto-merge
  - [ ] Integrate code sandbox (E2B or Daytona)
  - [ ] Wire GitHub App for read + draft PR
  - [ ] Implement repo-eligibility checker (size, test coverage, language support)
  - [ ] Eval set: 40 real bug-fix tickets across small/medium repos
  - [ ] Latency budget: <12 min cycle for "simple" tag
  - [ ] Wire tests-pass gate before PR submission
  - [ ] Add code-citation requirement in PR body
- [ ] **T4.3 — GR (Growth) — supervised**
  - [ ] Channel test design: landing variant, ad variant, copy variant
  - [ ] Attribution stub (UTM + Stripe charge correlation)
  - [ ] Spend cap enforcement before any ad call
  - [ ] Weekly experiment log writer
  - [ ] Eval set: 20 experiment briefs scored on hypothesis quality
- [ ] **T4.4 — FN (Finance) — autonomous read, supervised write**
  - [ ] Pull Stripe charges, refunds, payouts
  - [ ] Pull QuickBooks/Xero (Phase 3)
  - [ ] Compute runway, burn, MoM trend, top expenses
  - [ ] Anomaly flags (spend > 2σ on any vendor)
  - [ ] Weekly cost report assembly
  - [ ] Eval set: 25 ledger snapshots with expected runway/burn answers
- [ ] **T4.5 — MK (Marketing) — supervised**
  - [ ] Tone-matched draft generator (3 variants per request)
  - [ ] Brand voice eval (LLM-as-judge against brand book voice rules)
  - [ ] Scheduling adapter (Buffer-like internal or direct platform APIs)
  - [ ] Never auto-publish — approval gate always
- [ ] **T4.6 — OT (Ops) — autonomous**
  - [ ] Webhook health monitor
  - [ ] Vendor status-page poller
  - [ ] Auto-create approval card when a vendor goes degraded
  - [ ] Eval set: synthetic outage feeds with expected detection latency
- [ ] **T4.7 — CS (Customer Success) — supervised**
  - [ ] Inbox ingestion (Gmail, Outlook, Help Scout/Zendesk later)
  - [ ] Ticket classification (refund, bug, billing, sentiment)
  - [ ] Reply draft generator with tone calibration
  - [ ] Escalation rule: feeling / money / risk → human
  - [ ] Eval set: 50 redacted real-world tickets with graded reply quality
- [ ] **T4.8 — LG (Legal) — supervised (always)** 🔒
  - [ ] Contract parsing pipeline (PDF/DOCX → structured clauses)
  - [ ] Risk classifier (indemnity scope, auto-renew, IP assignment, liability caps)
  - [ ] Plain-English flag writer
  - [ ] **Mandatory disclaimer**: never legal advice, second-pair-of-eyes only
  - [ ] Eval set: 20 contracts with attorney-graded flag lists
- [ ] **T4.9 — ST (Strategy) + Sunday letter** 🎤
  - [ ] Sunday letter prompt template (brand-voice locked)
  - [ ] Weekly synthesis across all agent cycles
  - [ ] Pattern recognition: what shipped, what stuck, lessons
  - [ ] Email delivery via Postmark
  - [ ] Public letter archive at `[company].trent.app/letters` (opt-in)
- [ ] **T4.10 — Chat Strategist (competitor parity)** 🎤
  - [ ] Conversational front-door agent that translates founder asks into tasks
  - [ ] Routes work to the right specialist agent
  - [ ] Streams reasoning while planning
  - [ ] Maintains a "today's plan" view derived from chat
- [ ] **T4.11 — FR (Fundraising / VC outreach) — competitor parity, supervised**
  - [ ] Investor list ingestion (Crunchbase / manual import)
  - [ ] Personalized outreach draft (founder-voice matched)
  - [ ] CRM-style pipeline state per investor
  - [ ] Never auto-send — approval always
  - [ ] Eval set: 30 outreach drafts graded on personalization + tone
- [ ] **T4.12 — IDEA (Zero-to-one builder) — competitor parity**
  - [ ] "From idea → spec → repo → deploy" workflow
  - [ ] Idea-validation step (TAM, comp scan, fatal-flaw check)
  - [ ] Boilerplate generator (Next.js + Stripe + Postgres template)
  - [ ] First deploy to Vercel/Render gated by approval

---

## E5 — MCP Skills & Tool Layer

- [ ] **T5.0 — MCP foundations** 🔥
  - [ ] Read MCP spec end-to-end; pin to current SDK version
  - [ ] Decide transport: stdio for local dev, HTTP/SSE for production
  - [ ] Build `packages/mcp/server-kit` — shared helpers for auth, logging, error mapping
  - [ ] Build `packages/mcp/client` — used by orchestrator to call MCP servers
  - [ ] Define `Tool` envelope: `id, category, idempotency_key, dry_run, approval_policy`
  - [ ] Implement strict input validation via Zod
  - [ ] Implement strict output schema enforcement
  - [ ] Add per-tool unit test harness
- [ ] **T5.1 — MCP server: GitHub** 🔒
  - [ ] GitHub App registration; private key in KMS
  - [ ] Per-installation token cache with auto-refresh
  - [ ] Tools: `read_repo`, `get_file`, `list_issues`, `create_branch`, `commit_files`, `open_draft_pr`, `comment_on_pr`, `run_workflow`
  - [ ] Mark `commit_files` and `open_draft_pr` as `EXTERNAL_WRITE`
  - [ ] Unit tests against a sandbox repo
- [ ] **T5.2 — MCP server: Stripe** 🔒 💰
  - [ ] Restricted key per company (read-only by default)
  - [ ] Tools: `list_charges`, `list_payouts`, `list_customers`, `summarize_mrr`, `create_invoice` (write, gated)
  - [ ] Test mode wiring for local dev
- [ ] **T5.3 — MCP server: Postmark / Resend** 🔒
  - [ ] DKIM + SPF + DMARC setup checklist per company domain
  - [ ] Tools: `draft_email`, `send_email` (gated), `list_inbox` (via IMAP/Graph)
  - [ ] Bounce / complaint webhook handler
- [ ] **T5.4 — MCP server: Google Workspace**
  - [ ] OAuth scopes minimization
  - [ ] Tools: `gmail.list`, `gmail.read`, `gmail.send` (gated), `gdrive.list`, `gdrive.read`, `gcal.list`, `gcal.create_event` (gated)
- [ ] **T5.5 — MCP server: Microsoft 365**
  - [ ] App registration in Entra ID
  - [ ] Tools mirror Google Workspace surface
- [ ] **T5.6 — MCP server: Slack** 🎤
  - [ ] Slack app registration; bot + user tokens
  - [ ] Tools: `slack.post`, `slack.dm`, `slack.thread_reply`, `slack.search`
  - [ ] Slash command `/trent` → opens chat strategist in DM
- [ ] **T5.7 — MCP server: Linear / Jira / GitHub Issues**
  - [ ] Tools: `list_issues`, `create_issue`, `update_issue`, `add_comment`, `transition_status`
- [ ] **T5.8 — MCP server: Vercel / Render / Fly**
  - [ ] Tools: `list_projects`, `list_deployments`, `trigger_deploy` (gated), `set_env_var` (gated)
- [ ] **T5.9 — MCP server: Browserbase**
  - [ ] Session pool per company (cookies isolated)
  - [ ] Tools: `browse`, `fill_form` (gated), `screenshot`, `download_file`
- [ ] **T5.10 — MCP server: Meta Ads (competitor parity)** 🔒 💰 🎤
  - [ ] Business Manager + System User setup
  - [ ] Tools: `list_campaigns`, `create_campaign` (gated), `update_budget` (gated), `pause_campaign`, `pull_performance`
  - [ ] Hard spend cap pre-flight
  - [ ] Compliance copy guardrails (no claims that violate Meta policy)
- [ ] **T5.11 — MCP server: LinkedIn / X scheduling** 🎤
  - [ ] OAuth + token refresh
  - [ ] Tools: `draft_post`, `schedule_post` (gated), `pull_engagement`
- [ ] **T5.12 — MCP server: Code Sandbox (E2B / Daytona)** 🔒
  - [ ] Per-cycle ephemeral environment
  - [ ] Tools: `exec_cmd`, `read_file`, `write_file`, `run_tests`, `kill_session`
  - [ ] Network egress allowlist
- [ ] **T5.13 — MCP server: Vector / Memory** 🔒
  - [ ] Internal MCP wrapping memory layer (so agents call it identically)
  - [ ] Tools: `search_memory`, `write_fact`, `correct_fact`, `forget`
- [ ] **T5.14 — MCP server registry & loader**
  - [ ] Per-company enabled-server config
  - [ ] Per-server health probe
  - [ ] Tool discovery surface in admin UI
  - [ ] Versioning + deprecation policy
- [ ] **T5.15 — Tool safety review** 🔒
  - [ ] Every tool has documented blast radius
  - [ ] Every `SPENDS_MONEY` tool has hard cap
  - [ ] Every `EXTERNAL_WRITE` tool has dry-run mode
  - [ ] Pen test: prompt-inject an agent into calling forbidden tools

---

## E6 — Approval Queue & Permission Model

- [ ] **T6.1 — Data model**
  - [ ] `approvals` table + state machine (`pending → approved | rejected | expired`)
  - [ ] `approval_policy` table per company per tool category
  - [ ] Defaults: `EXTERNAL_WRITE` + `SPENDS_MONEY` = always approval; `INTERNAL_WRITE` = configurable; `READ_ONLY` = none
- [x] **T6.2 — UX**
  - [x] Approval queue page
  - [x] "One decision today" card (M/01) in console home
  - [x] Inline diff for code PRs
  - [x] Inline contract markup for legal flags
  - [x] Send-as-drafted preview for emails / posts
  - [x] Bulk-approve with safeguards (limit per action category) — max 5 per batch, shows count
- [ ] **T6.3 — Notifications**
  - [ ] Email digest (config: instant / hourly / daily)
  - [ ] Slack DM channel option
  - [ ] iOS/Android push (Phase 3)
- [x] **T6.4 — Auto-approval rules**
  - [x] Autonomy level setting controls approval gates (review_only → autonomous_within_limits)
  - [x] Audit every change via `store.addAudit`
- [x] **T6.5 — Expiry handling**
  - [x] Default 48h expiry per approval
  - [x] Configurable per tool
  - [x] Re-plan on expiry (don't silently drop)

---

## E7 — The Console (App UI)

- [x] **T7.1 — Information architecture**
  - [x] Portfolio sidebar (multi-company)
  - [x] Per-company tabs: Console · Queue · Approvals · Reports · Memory · Public page
  - [x] Operate drawer: Cycles · Budgets · Audit log · Integrations
- [x] **T7.2 — Operating console (home)**
  - [x] Cycle banner with live status (SSE-wired)
  - [x] Agent activity stream
  - [x] One-decision-today card
  - [x] Today's cycle digest (right rail)
- [x] **T7.3 — Queue page**
  - [x] Filters: agent, status, age, cost
  - [x] Sort by impact score
- [x] **T7.4 — Reports**
  - [x] Daily report (auto-generated)
  - [x] Weekly Sunday letter view
  - [x] Cost ledger
  - [x] Cycle outcome stats
- [x] **T7.5 — Memory search (M/06)** 🎤
  - [x] Search bar with debounce + cmd-K open
  - [x] Mixed result list (docs, decisions, customer notes, agent transcripts, metrics)
  - [x] Highlight matched span; jump to source
- [x] **T7.6 — Public company page (M/05)** 🎤
  - [x] `[company].trent.app` subdomain routing (next.config.ts rewrite via BASE_DOMAIN env)
  - [x] Opt-in toggle per company (in settings)
  - [x] Editable sections: what shipped, what's learning, current focus
  - [x] Open Graph metadata for sharing
- [x] **T7.7 — Console aesthetics — brand-book compliant** 🎤
  - [x] Implement Inter / Instrument Serif / JetBrains Mono via next/font
  - [x] Theme tokens: obsidian/ink/steel/bone/pulse/ember/mist/flare
  - [x] Pulse for AI-moved, ember for human-needed (rule R/02 of brand book)
  - [ ] 90/8/2 color discipline check (Lint rule in PR review)
  - [x] Empty states end with "Trent's got it."
  - [x] Header morning copy: "good morning, [name] — trent's been working."
- [x] **T7.8 — Mobile responsive**
  - [x] Approval inbox usable on phone (priority)
  - [x] Read-only console view
- [x] **T7.9 — Onboarding flow** 💰 🎤
  - [x] Create-company wizard
  - [x] Connect-integrations wizard (GitHub live, others coming-soon modal)
  - [x] First-cycle trigger + live watch screen (SSE live indicator)
  - [x] 14-day trial countdown banner

---

## E8 — Integrations (Customer-Facing)

> Engineering for E5 happens server-side; this Epic owns the customer onboarding surface for each integration.

- [x] **T8.1 — Integrations directory page**
  - [x] Card per integration with status (connected, mocked, not connected)
  - [x] Per-integration setup wizard (GitHub live; others show coming-soon modal)
- [x] **T8.2 — GitHub install flow** 🔒
  - [x] GitHub token + owner + repo form (modal in Integrations page)
  - [ ] GitHub App install button (OAuth app pending)
  - [ ] Repo picker (allowlist per company)
- [ ] **T8.3 — Stripe connect flow** 🔒
  - [ ] Stripe Connect or restricted key paste
  - [ ] Test the connection live (round-trip a charge read)
- [ ] **T8.4 — Postmark / Resend setup** 🔒
  - [ ] Domain verification checklist (DKIM / SPF / DMARC)
  - [ ] In-app DNS-record helper
- [ ] **T8.5 — Google / Microsoft connect**
  - [ ] OAuth consent screens
  - [ ] Per-scope justification copy
- [ ] **T8.6 — Slack add-to-workspace**
  - [ ] Public Slack app submission
  - [ ] Bot scopes minimized
- [ ] **T8.7 — Meta Ads connect** 🔒 💰
  - [ ] Business verification walkthrough
  - [ ] Pixel + Conversions API setup helper
- [ ] **T8.8 — Vercel / Render connect**
  - [ ] OAuth + project picker
- [ ] **T8.9 — Browserbase pool**
  - [ ] Per-company project provisioning
- [x] **T8.10 — Integration disconnect / revoke**
  - [x] One-click revoke + key rotation
  - [x] Audit log entry on revoke

---

## E9 — a competing product-Parity Features

- [x] **T9.1 — Nightly autonomous run** 🎤
  - [x] User sets "nightly window" in settings
  - [x] Worker schedules cycles across enabled agents (runDueScheduledCycles checks nightlyRunHour; scheduler sweep in /api/jobs/scheduler)
  - [x] Morning briefing email assembled (assembleMorningBriefing; mocked Postmark delivery Phase 1)
- [ ] **T9.2 — Cold email outbound** 🎤 🔒
  - [ ] List ingestion (CSV, Apollo-style imports later)
  - [ ] Per-contact personalization
  - [ ] Deliverability scoring before send
  - [ ] Compliance: CAN-SPAM, GDPR, unsubscribe link mandatory
  - [ ] Reply detection + thread continuation
- [ ] **T9.3 — Inbox management** 🎤
  - [ ] Triage rules per company
  - [ ] Auto-categorize: customer, vendor, investor, recruiter, spam
  - [ ] Per-category playbooks (delegate to CS / FR / etc.)
- [ ] **T9.4 — Meta Ads autonomous campaigns** 💰 🎤
  - [ ] Campaign brief intake (objective, audience, budget cap)
  - [ ] Creative draft pipeline (image + copy variants)
  - [ ] Launch gate (approval)
  - [ ] Daily performance pull + auto-pause on underperformance
  - [ ] Compliance review pass before any launch
- [ ] **T9.5 — Social media campaigns** 🎤
  - [ ] LinkedIn + X scheduling
  - [ ] Engagement monitoring (mentions, replies)
  - [ ] Calendar view of upcoming posts
- [ ] **T9.6 — VC outreach / fundraising** 🎤
  - [ ] Investor pipeline kanban
  - [ ] Per-investor research dossier
  - [ ] Email cadence engine (gated send)
  - [ ] Meeting scheduler integration
- [ ] **T9.7 — Idea → product zero-to-one** 🎤
  - [ ] Validation pre-flight (TAM scan, comp scan, fatal-flaw check)
  - [ ] Spec draft → repo bootstrap → first deploy
  - [ ] Landing page generation + domain wiring
  - [ ] First waitlist captured to memory
- [ ] **T9.8 — Revenue-share pricing variant** 💰 🎤
  - [ ] Optional plan: lower base + % of Stripe revenue
  - [ ] Stripe Connect for measurement
  - [ ] Cap on monthly take
- [x] **T9.9 — Sleep-mode operating manifesto** 🎤
  - [x] Marketing copy: "Trent runs your company while you sleep" (landing page SleepManifestoSection with overnight log visualization)
  - [x] Built-in demo run accessible without signup

---

## E10 — Enterprise Hardening & Security

- [ ] **T10.1 — Credential vault** 🔒 🔥
  - [ ] Envelope encryption: KMS master + per-company DEK
  - [ ] Encrypted at rest in `credentials` table
  - [ ] Decryption only inside worker context
  - [ ] Never expose raw tokens to LLM (always reference by handle)
  - [ ] Rotation API + UI
  - [ ] Quarterly key-rotation runbook
- [ ] **T10.2 — Authentication & sessions** 🔒
  - [ ] WorkOS / Clerk integration
  - [ ] Email + password (Argon2id), magic link, Google OAuth
  - [ ] SAML / SSO for paid tiers (Phase 2)
  - [ ] SCIM provisioning (Phase 3)
  - [ ] 2FA mandatory for admin role
  - [ ] Session timeout + device list + revoke
- [ ] **T10.3 — Authorization**
  - [ ] RBAC: owner / builder / operator / viewer per company
  - [ ] Per-tool fine-grained permissions
  - [ ] Approval-only operator role
- [x] **T10.4 — Audit log** 🔒 💰
  - [x] Every state change writes immutable row (via `store.addAudit` in all mutations)
  - [x] Tamper-evident chain (SHA-256 prevHash → hash per entry, shown in UI)
  - [x] Customer-facing export (CSV export in audit UI)
  - [ ] Retention: 1 year minimum (in-memory; Postgres needed for persistence)
- [ ] **T10.5 — Prompt-injection defense** 🔒 🧪
  - [ ] Tag retrieved content as `untrusted`
  - [ ] Separate intent vs content parsing pass
  - [ ] Tool calls validated against strict schema; reject unknown
  - [ ] Sandbox shell with allowlist commands
  - [ ] Pen test suite for injection attacks
- [ ] **T10.6 — Network controls**
  - [ ] Worker egress allowlist
  - [ ] Mutual TLS between worker and MCP servers
  - [ ] WAF in front of public surfaces
- [ ] **T10.7 — Secrets in code**
  - [ ] gitleaks pre-commit hook
  - [ ] CI secret scanning
  - [ ] Rotate any leaked secret within 1h playbook
- [x] **T10.8 — Backup & restore**
  - [x] Postgres PITR enabled (configured on Supabase dashboard)
  - [x] Daily snapshot test-restore in staging (`pg-restore-drill.sh`)
  - [x] Documented RTO / RPO targets (`scripts/backup/README.md`)
- [ ] **T10.9 — Reliability**
  - [ ] 99.5% uptime SLA target
  - [ ] On-call rotation (even if 2 people)
  - [ ] Incident severity matrix + runbooks
  - [ ] Status page subscribers automation

---

## E11 — SOC 2 / GDPR / Compliance Prep

- [ ] **T11.1 — Choose compliance platform** 💰
  - [ ] Vanta vs Drata vs Secureframe trial
  - [ ] Sign contract, begin observation window — **do this in week 1, not month 6**
- [ ] **T11.2 — SOC 2 Type I**
  - [x] Map controls (CC1–CC9) (`docs/security/controls-mapping.md`)
  - [x] Write policies: information security, access control, change management, vendor management, incident response, BCP/DR, acceptable use (`docs/security/policies/`)
  - [ ] Employee training enrollment
  - [ ] Background checks for any new hires
  - [ ] First audit (Type I) by month 9
- [ ] **T11.3 — SOC 2 Type II**
  - [ ] 6-month observation window
  - [ ] Quarterly access reviews
  - [ ] Quarterly vendor reviews
  - [ ] Annual pen test
  - [ ] Type II report by month 15-18
- [ ] **T11.4 — GDPR scope**
  - [ ] Data Processing Agreement template
  - [ ] Sub-processor list (public)
  - [ ] Privacy policy review by counsel
  - [ ] DSR (data subject request) endpoint: export + delete
  - [ ] Cookie banner (legitimate-interest minimal)
  - [ ] EU region rollout plan
- [ ] **T11.5 — Model-provider terms**
  - [ ] Anthropic enterprise terms (no training on customer data)
  - [ ] OpenAI enterprise terms or zero-retention
  - [ ] Document each in `docs/compliance/subprocessors.md`
- [ ] **T11.6 — Trust Center** 🎤 💰
  - [ ] Public page at `trent.com/trust`
  - [ ] Sub-processor list
  - [ ] Status page link
  - [ ] Security whitepaper PDF
  - [ ] Annual pen test summary (redacted)
- [ ] **T11.7 — Vendor due diligence**
  - [ ] Track each sub-processor's SOC 2
  - [ ] Re-review annually

---

## E12 — Billing & Pricing

- [x] **T12.1 — Pricing model** 💰 🎤
  - [x] Tier definitions: Operator $99 / Studio $299 / Enterprise custom (landing page)
  - [ ] Metered overage units (cycles, external actions, additional companies)
  - [x] Annual discount (2 months free)
  - [ ] Revenue-share alternative plan (competitor parity)
- [ ] **T12.2 — Stripe billing implementation**
  - [ ] Stripe Products + Prices configured
  - [ ] Checkout flow
  - [ ] Customer portal embed
  - [ ] Webhook handler for invoice events
  - [ ] Dunning + failed-card retry
- [ ] **T12.3 — Credit ledger**
  - [ ] Per-company balance table
  - [ ] Per-cycle deduction with reservation pattern
  - [ ] Top-up flow
  - [x] In-product cost banner (FN agent surface) — dashboard shows soft-warn at 75%, hard-stop at 100%
- [ ] **T12.4 — Free trial**
  - [x] 14-day trial, no credit card required (test against requires-card variant)
  - [x] Trial-end nudges (ember banner with upgrade link when daysLeft <= 0)
  - [x] "14-day guarantee" copy (1 PR / 1 post / 1 letter) — shown in trial banner last 3 days
- [x] **T12.5 — Referral program** 🎤
  - [x] $99 credit per referred paying company
  - [x] Unique link per user (deterministic code from userId; /referral page)
  - [x] Dashboard: pending / converted / paid (ReferralPageClient with stats cards, link copy, how-it-works, referrals table)

---

## E13 — Evals, Quality Labels & Agent Lab

- [ ] **T13.1 — Eval platform** 🧪 🔥
  - [ ] Choose Braintrust vs LangSmith vs in-house
  - [ ] Wire trace export
  - [ ] Define scoring rubrics per agent
- [ ] **T13.2 — Frozen eval sets per agent**
  - [ ] PM: 30 cases · EG: 40 · GR: 20 · FN: 25 · MK: 30 · OT: 15 · CS: 50 · LG: 20 · ST: 10 · FR: 30 · IDEA: 15
  - [ ] Ground-truth annotation playbook
  - [ ] Versioning + diffing of eval sets
- [ ] **T13.3 — Online evals**
  - [ ] Sample 5% of production traffic
  - [ ] LLM-as-judge with calibrated rubric
  - [ ] Human spot review on disagreements
- [ ] **T13.4 — Regression gating in CI**
  - [ ] Eval job runs on PR
  - [ ] Block merge if any agent regresses > defined threshold
  - [ ] Override flow with justification + reviewer
- [x] **T13.5 — Quality label surface** 🎤
  - [x] Label per agent (experimental / supervised / autonomous)
  - [x] Show in console next to agent name (Agents page + Settings agents tab)
  - [x] Surface in landing copy (quality labels on each agent card + legend with honest "experimental" callout)
- [ ] **T13.6 — Canary cycles**
  - [ ] Route 1% of cycles to candidate prompt/model
  - [ ] Compare outcomes; auto-rollback on regression
- [ ] **T13.7 — Self-healing**
  - [ ] On failure, agent re-plans with adjusted constraints
  - [ ] Bounded retry depth

---

## E14 — Validation, Pilot, & Dogfooding

- [ ] **T14.1 — Dogfood internally** 🔥 🎤
  - [ ] Run Trent's own company on Trent
  - [ ] Public dashboard at `trent.trent.app` showing live cycles
  - [ ] Weekly Sunday letter published publicly
- [ ] **T14.2 — Design partner program**
  - [ ] Recruit 10 founder design partners
  - [ ] Per-partner Slack channel
  - [ ] Weekly office hours
  - [ ] LOI / data-usage agreement template
- [ ] **T14.3 — Activation metric instrumentation** 🔥
  - [ ] Define: `cycles_approved_per_active_company_per_week`
  - [ ] Dashboard in PostHog / Mixpanel / homegrown
  - [ ] Per-cohort breakdown
- [ ] **T14.4 — Founder-time-saved survey**
  - [ ] In-product weekly micro-survey
  - [ ] Self-reported hours saved
  - [ ] Correlate with retention
- [ ] **T14.5 — Public proof artifacts** 🎤
  - [ ] Build a "before / after Trent" case-study template
  - [ ] First 3 case studies by month 6 of paid GA
- [ ] **T14.6 — Pilot SOW (light, for power users)**
  - [ ] Even at PLG, a 30-day "concierge pilot" SKU for $1-2K
  - [ ] Success criteria written into the form
- [ ] **T14.7 — Customer interview cadence**
  - [ ] 5 customer interviews per week, first 6 months
  - [ ] Logged in a shared Notion / customer.io

---

## E15 — GTM, Landing, & Launch Assets

- [x] **T15.1 — Landing redesign per brand book ed.02** 🎤
  - [x] Hero rewrite: "The one hire who does it all."
  - [x] Insert "The Hire" band (salary comparison table)
  - [x] Replace mechanism grid with "Needs doing?" outcome grid
  - [x] Marquee ticker with verb-first copy
  - [x] Sunday letter preview band
  - [x] Stats row: $1M+ / 0 / 9 / 24-7
  - [x] CTA: "hire trent →"
  - [x] Footer line: "trent · the one hire"
- [ ] **T15.2 — Sunday letter as marketing channel** 🎤
  - [ ] Substack or self-hosted
  - [ ] Weekly redacted Trent-on-Trent letter
  - [ ] Cross-post excerpts on X
- [ ] **T15.3 — Founder content engine**
  - [ ] X cadence (3 posts / week)
  - [ ] One long-form essay / month
  - [ ] One short-form video / week (the founder demoing a real cycle)
- [ ] **T15.4 — Launch sequence**
  - [ ] Private beta (waitlist + 100 invites)
  - [ ] Paid GA
  - [ ] Show HN
  - [ ] Product Hunt launch (time after GitHub-writes are live)
  - [ ] IndieHackers post
- [ ] **T15.5 — Sales / pitch assets**
  - [ ] One-pager (for accelerator partners)
  - [ ] 8-slide investor / partner deck
  - [ ] Demo video (4-min, no narration, just cycle running)
  - [ ] ROI calculator widget on the site
- [ ] **T15.6 — Accelerator partnerships**
  - [ ] Target 5 accelerators by end of 2026 (YC, Techstars, AI Grant, South Park Commons, Antler)
  - [ ] Founder discount code per accelerator
- [ ] **T15.7 — Community**
  - [ ] Trent founders' Slack/Discord
  - [ ] Monthly community demo day
- [ ] **T15.8 — Analytics**
  - [ ] PostHog for product analytics
  - [ ] Plausible / Fathom for site analytics (privacy-first)
  - [ ] Source attribution (UTM scheme + Stripe coupon mapping)

---

## E16 — Operations, Support, & Scaling

- [ ] **T16.1 — Customer support**
  - [ ] Support inbox (Plain, Help Scout, or in-product)
  - [ ] First-response SLA: 4h business hours
  - [ ] Knowledge base bootstrap (20 articles)
- [ ] **T16.2 — On-call**
  - [ ] PagerDuty or Incident.io setup
  - [ ] Sev1/Sev2 definitions
  - [ ] Postmortem template
- [ ] **T16.3 — Cost engineering**
  - [ ] Per-tenant cost dashboard
  - [ ] Per-agent cost dashboard
  - [ ] Gross margin target: 60% by Phase 3
  - [ ] Model-substitution experiments (Sonnet → Haiku for cheap-tasks)
- [ ] **T16.4 — Capacity & scale**
  - [ ] Load test: 1k concurrent cycles
  - [ ] Worker autoscale policy
  - [ ] Postgres connection pool tuning (PgBouncer)
  - [ ] Read-replica for analytics queries
- [ ] **T16.5 — Hiring (when justified)**
  - [ ] First hire: applied AI engineer (eval + RAG focus)
  - [ ] Second hire: platform engineer (durable runtime + infra)
  - [ ] Third hire: design / front-end (console UX)
  - [ ] Founder-led sales for first 50 customers

---

## E17 — Viktor-Parity Operating Coworker Features

> Goal: match Viktor.com's strongest outcome promise without making Trent Slack-native. Trent should remain an in-app company console where a founder can ask for work, watch the AI operating team execute, review sensitive actions, and receive real artifacts.

- [x] **T17.1 — Ask Trent / Command Center** 🔥 🎤
  - [x] Add persistent front-door chat inside the company console, not Slack-first (CeoCommandClient at /command)
  - [x] Translate natural-language asks into structured plans, tasks, approvals, artifacts, and cycles (createTasks[] + createArtifacts[] in ceoChatResponse; CEO API creates tasks/artifacts on POST)
  - [x] Route requests to the correct 9-seat operating hierarchy (agentRole routing in createTasks; system prompt includes slot definitions)
  - [x] Show "what Trent understood" before execution (understood card: intent, routedTo, willDo, approvalRequired banner)
  - [ ] Stream planning and execution state (SSE wired in AppShell; individual chat streaming pending)
  - [x] Support follow-up commands: "make it a PDF", "turn this into a recurring task", "run this every Monday" (artifact format follow-up + recurring follow-up both implemented)
  - [x] Add command history per company (listCeoMessages persisted; shown in chat thread)
  - [ ] Eval set: 50 founder requests mapped to expected tasks/routes/artifacts
- [ ] **T17.2 — Artifact Builder** 🎤
  - [x] Define artifact types: board PDF, XLSX report, dashboard, investor update, campaign report, competitive research doc, operating memo, support summary
  - [x] Add `Artifact` model/table: company, source task/cycle, type, status, storage key, preview URL, export format, createdByAgent
  - [x] Generate polished PDF reports with charts, tables, executive summary, sources, and action list (dependency-free PDF export landed; chart/table polish can deepen with Workbench rendering)
  - [x] Generate XLSX workbooks with multiple sheets, formulas where useful, and styled summary tabs (real XLSX workbook export landed with Summary, Actions, Sources, Content sheets; formulas/styling can deepen)
  - [x] Generate dashboard artifacts that can be viewed in-app and exported as PDF/image (dashboard JSON + in-app preview landed; image export pending)
  - [ ] Attach artifacts to tasks, reports, memory, approvals, and public company page when visibility allows
  - [x] Add artifact preview drawer with download, regenerate, share, and approve/send actions (preview/download PDF/XLSX/HTML/CSV/JSON + approve + regenerate + share landed; send pending)
  - [x] Store artifact provenance: inputs, sources, model/tool calls, timestamp, cost, and approval state
  - [ ] Playwright test: request competitive analysis → artifact appears → PDF/XLSX download works
- [ ] **T17.3 — Cloud Workbench / Trent's Computer** 🔥 🔒 🎤
  - [x] Provision per-company/per-task sandbox environments for browser, shell, repo checkout, test runner, and artifact generation (mock_local provider landed; E2B/Daytona next)
  - [x] Pick sandbox provider interface: `WorkbenchProviderAdapter` in lib/workbench-provider.ts; mock_local registered; E2B/Daytona add as separate providers with no other changes needed
  - [x] Implement workbench session model: `id, companyId, taskId, agentRole, status, startedAt, stoppedAt, cost, storage`
  - [x] Tools: `workbench.exec`, `workbench.read_file`, `workbench.write_file`, `workbench.run_tests`, `workbench.screenshot`, `workbench.capture_artifact` — all implemented in mock_local provider + 5 action API routes
  - [x] Add repo checkout flow with branch isolation and no raw secret exposure to the model (GitHub + GitLab + Bitbucket; VCS provider routing + ASKPASS credential injection in lib/git-checkout.ts)
  - [x] Write sandbox provider decision doc: E2B vs Daytona comparison — pricing, startup latency, API surface, security posture (docs/superpowers/specs/2026-05-28-sandbox-provider-decision.md; Status: Approved)
  - [x] Write third-party sandbox security review: threat model, E2B/Daytona security docs audit, findings (docs/superpowers/specs/2026-05-28-third-party-sandbox-security-review.md; Status: Approved)
  - [x] Branch + patch workflow: git diff, conflict detection (git merge-tree --write-tree), three-way merge (git apply --3way) — standalone lib/git.ts, 8 tests green
  - [x] Test runner auto-detection: pattern-match package.json/file presence to detect Jest/Vitest/pytest/etc — standalone lib (lib/test-runner.ts; 17 tests green)
  - [x] Add browser automation with screenshots, DOM snapshots, download capture, and approval gates for login/submit/purchase/download (WorkbenchBrowserSession with stealth mode, CAPTCHA detection, human handoff in lib/workbench-browser.ts; Playwright screenshots with responsive viewports in lib/workbench-screenshot.ts; live preview URL via port probing + cloudflared tunnel in lib/workbench-preview.ts)
  - [x] Add network egress allowlist and per-session runtime/cost limits (metadata.networkPolicy + maxRuntimeSeconds + maxCostCents enforced at session creation; egress firewall in E2B/Daytona)
  - [x] Persist logs, screenshots, generated files, test results, and terminal output for replay/audit (WorkbenchEvent + WorkbenchArtifact models; every provider action emits events)
  - [x] Require approval before external writes: commits, PRs, deploys, form submits — exec blocks and emits needs_approval event for git push, npm publish, vercel deploy, fly deploy, etc.
  - [x] Integration test: sandbox dies mid-run → job resumes or fails cleanly with artifact/log preservation (lib/workbench-orchestrator.test.ts "sandbox crash mid-run")
  - [x] E2B / Daytona real sandbox pilot (lib/workbench-e2b-provider.ts — E2B Sandbox adapter registered)
- [x] **T17.4 — Proactive Automations / Heartbeat System** 🔥 🎤
  - [x] Add heartbeat scanner (runHeartbeatScan in /api/companies/:id/automations POST; detects 5 pattern types)
  - [x] Detect recurring work patterns: weekly reports, pending approval backlog, no nightly schedule, stale PR queue, no growth tasks
  - [x] Generate automation suggestions with reason, schedule, required tools, approval policy, estimated cost, owner slot
  - [x] "Own it / Later / ×" approval card in Command Center (respondToAutomation sends accept/snooze/reject)
  - [x] Convert accepted suggestions into recurring task templates (createRecurringTask on accept)
  - [x] Add snooze, reject controls
  - [ ] Track suggestion quality (phase 2 DB)
  - [ ] Eval set (phase 2)
- [ ] **T17.5 — Real Integrations Expansion** 🔥 🔒 💰
  - [ ] Stripe: OAuth/restricted-key connect, revenue/MRR/churn pulls, invoices/refunds gated, billing webhooks
  - [ ] GitHub: production GitHub App, repo picker, branch creation, commit files, draft PRs, workflow runs, PR review comments
  - [ ] Linear: OAuth, list/create/update issues, comments, status transitions, project sync
  - [ ] Notion: OAuth, database/page read/write, content search, task/report publishing
  - [ ] Google Drive/Gmail: OAuth, Drive file read/search, Gmail draft/send with approval, Calendar event create with approval
  - [ ] PostHog: metrics/events/cohorts/funnels read, dashboard snapshots, anomaly detection
  - [ ] Meta Ads: campaign/adset/ad read, campaign draft, budget changes gated, launch/pause gated, daily performance pull
  - [ ] HubSpot: contacts/companies/deals/tickets read/write, pipeline follow-up drafts, CRM notes
  - [ ] Sentry: issue/error read, release health, incident summaries, create GitHub/Linear follow-up tasks
  - [ ] Add integration health checks, scope display, revoke/rotate, and audit trail for every connector
  - [ ] Add managed-connector strategy research for "long tail" tools without building 3,000 native connectors
- [ ] **T17.6 — Internal App Builder** 🎤 🔒
  - [ ] Add "build an internal tool" workflow: ask → spec → data sources → UI plan → sandbox build → preview → approval → deploy
  - [ ] Supported app types: dashboard, calculator, admin panel, tracker, competitive monitor, KPI report, customer list, ops tool
  - [ ] Generate app specs with auth, database/storage needs, data refresh cadence, permissions, and owner
  - [ ] Scaffold apps from approved templates: Next.js dashboard, lightweight worker/report, static artifact, data table app
  - [ ] Preview generated app in isolated environment with test data and screenshots
  - [ ] Add approval gate before connecting live data, deploying, or exposing a public/private URL
  - [ ] Store generated apps in GitHub with clear ownership and rollback notes
  - [ ] Add app registry in Trent: status, preview URL, prod URL, linked repo/PR, schedule, owner slot, last refresh
  - [ ] E2E test: "Build me a churn dashboard" → preview created → approval requested → app registered
- [ ] **T17.7 — Team Collaboration Inside Trent** 🎤
  - [x] Add in-app comments on tasks, approvals, reports, artifacts, cycles, and integrations (CommentThread on approvals + tasks; entity-agnostic API)
  - [x] Add @mentions for team members and agent seats (`@CEO`, `@Engineer`, `@Finance`) (CommentThread autocomplete + rendering)
  - [ ] Add assignment model: owner user, owner agent slot, due date, priority, watchers
  - [x] Add notification center with unread mentions, approvals, failed jobs, completed artifacts, and proactive suggestions (bell + dropdown in TopBar)
  - [x] Add approval discussion threads so users can ask agents follow-up questions before approve/reject
  - [ ] Add decision log linking comments, approvals, artifacts, and final outcomes
  - [x] Add team activity feed: user actions, agent actions, comments, assignments, state changes (unified /activity API + dashboard panel)
  - [ ] Add email/web push notifications first; keep Slack/Teams optional as later notification channels, not the primary product surface
  - [ ] RBAC: owner/admin/operator/viewer permissions for commenting, approving, assigning, and seeing private artifacts
- [ ] **T17.8 — Viktor-Parity Packaging & Proof** 💰 🎤
  - [x] Add landing/product copy: "real outputs, not just chat" while preserving Trent's "AI operating team" positioning
  - [x] Add public demo flows: ad audit report, competitive PDF, churn dashboard, GitHub PR, investor update
  - [ ] Add credit model research: task credits vs pass-through model/tool costs vs hybrid subscription
  - [ ] Add "first $100 credits" / trial-credit experiment to pricing roadmap
  - [x] Add trust copy: credentials invisible to AI, approval gates, no training on customer data, isolated workspaces
  - [x] Build ROI calculator around hours saved, reports generated, follow-ups completed, issues created, spend caught

---

## E18 — Person-Like Social Operator (X + Instagram)

> Goal: make Trent feel person-like in quality, timing, context, and memory while staying transparent, supervised, official-API-only, and respectful of platform rules. Trent should behave like a careful social media operator for the company, not a deceptive human impersonator or engagement bot.

- [ ] **T18.1 — Social operating policy & safety contract** 🔥 🔒 🎤
  - [ ] Write Trent Social Operator policy: transparent identity, no fake engagement, no deceptive impersonation, no spam, no scraping, official APIs only
  - [ ] Define social autonomy modes: `draft_only`, `approve_before_publish`, `auto_reply_low_risk`, `manual_only_sensitive`
  - [ ] Define allowed actions per mode: draft post, schedule post, reply, comment suggestion, DM draft, lead tag, report, escalation
  - [ ] Define prohibited actions: mass unsolicited replies, auto-like/follow at scale, follower/comment exchange behavior, trending-topic manipulation, browser scraping, credential sharing
  - [ ] Add platform-specific rule map for X and Instagram/Meta; include source links and last-reviewed date
  - [ ] Add "stop/opt-out" handling policy for DMs/replies where platform rules require it
  - [ ] Add disclosure model: account bio/label guidance for automated accounts and "posted with Trent" optional disclosure for supervised brand accounts
  - [ ] Add social risk classifier categories: legal, medical/financial advice, personal data, controversy, harassment, crisis/support, pricing promises, competitor claims, political content
  - [ ] Add escalation rules: any sensitive/high-risk category must become approval or human task, never auto-publish
- [ ] **T18.2 — Social brand memory & personality system** 🎤
  - [ ] Add `SocialBrandVoice` model: tone, vocabulary, banned phrases, approved claims, taboo topics, emoji policy, humor level, formality level
  - [ ] Add per-channel voice settings: X short-form style, Instagram caption style, comment style, DM style
  - [ ] Add founder/company examples library: approved posts, rejected posts, competitor examples, customer language
  - [ ] Add voice calibration flow: Trent drafts 10 posts → user rates/edit → memory stores authoritative style signals
  - [ ] Add "person-like timing" preferences: posting windows, reply delay range, quiet hours, max actions/day, cadence by channel
  - [ ] Add conversation memory: remembers prior interactions with handles/users, sentiment, lead stage, last reply, opt-out state
  - [ ] Add brand consistency eval: compare generated social output against brand voice and claims policy
- [ ] **T18.3 — Social content calendar & planning** 🎤
  - [ ] Add content calendar model: channel, scheduledAt, status, campaign, asset, owner agent, approvalId
  - [ ] Add weekly social plan generator from company goals, recent cycles, artifacts, launches, and customer signals
  - [ ] Add content pillars: build-in-public, proof/results, founder POV, education, product demo, customer story, offer/CTA, community replies
  - [ ] Add post series support: multi-post X threads, Instagram carousel concepts, launch sequences, weekly recurring themes
  - [ ] Add asset requirements: image/video needed, source artifact, screenshot, alt text, link tracking, UTM tags
  - [ ] Add calendar UI: draft, needs approval, scheduled, published, failed, archived
  - [ ] Add "why this post" rationale: audience, goal, expected signal, approval risk, CTA
- [ ] **T18.4 — X integration, official API only** 🔥 🔒 🎤
  - [ ] Create X developer app and OAuth flow with least-privilege scopes
  - [ ] Store encrypted X tokens per company/account; add revoke/rotate and audit trail
  - [ ] Implement X health check: auth valid, scopes, rate limit state, account metadata
  - [ ] Implement read surfaces: own posts, mentions, replies, selected conversations, engagement metrics where API allows
  - [ ] Implement draft post and draft reply tools first; no auto-publication until approval gates pass
  - [ ] Implement approved publish post via official API
  - [ ] Implement approved reply to user who engaged first; max one automated reply per interaction unless human approves continuation
  - [ ] Implement quote/repost suggestion with approval and anti-manipulation guard
  - [ ] Block automated likes unless directly user-initiated in UI
  - [ ] Block scraping/browser automation for X; enforce API-only adapter path
  - [ ] Add X rate-limit handling, retry/backoff, and "degraded draft-only" mode
  - [ ] Add tests for policy blocks: unsolicited mention, bulk replies, trending manipulation, auto-like, scraping path
- [ ] **T18.5 — Instagram/Meta integration, official Graph API only** 🔥 🔒 🎤
  - [ ] Create Meta app; document App Review requirements and screenshots for required permissions
  - [ ] Add OAuth/connection flow for Instagram Business/Creator accounts through Meta
  - [ ] Store encrypted Meta/Instagram tokens per company/account; add revoke/rotate and audit trail
  - [ ] Implement Instagram health check: page/account linkage, token validity, scopes, app review status
  - [ ] Implement content publishing draft flow: caption, media asset, alt text, hashtags, first comment option where allowed
  - [ ] Implement approved publish flow for supported media types through Instagram Graph API
  - [ ] Implement comment inbox: read comments, classify sentiment/intent/risk, draft replies
  - [ ] Implement approved comment reply via official API
  - [ ] Implement DM draft/reply flow only where user engaged and permissions/session windows allow
  - [ ] Add media constraints validator: image/video dimensions, file size, supported formats, quality warnings
  - [ ] Add Meta rate-limit handling, app-review degraded states, and fallback to draft/manual instructions
  - [ ] Block unofficial Instagram browser automation and engagement-bot behavior
- [ ] **T18.6 — Social inbox & conversation console** 🎤
  - [ ] Add unified social inbox: X mentions/replies, Instagram comments/DMs, status, channel, customer/lead tag
  - [ ] Add conversation cards with context: prior interaction, company memory, relevant artifact/task, sentiment, risk level
  - [ ] Add reply composer: Trent draft, edit, approve/send, reject, assign to human, convert to task
  - [ ] Add "person-like but safe" response timing: optional delayed send after approval, quiet hours, max reply rate
  - [ ] Add opt-out detection: "stop", "unsubscribe", "don't contact me" → suppress future DMs/replies and audit
  - [ ] Add lead detection: buying intent, partnership intent, support issue, churn risk, investor interest
  - [ ] Add route-to-agent actions: support ticket, sales follow-up, content idea, product bug, finance/billing escalation
  - [ ] Add customer profile linking to CRM/HubSpot later
- [ ] **T18.7 — Approval gates & audit for social actions** 🔒 🎤
  - [ ] Add approval action types: `social.post.publish`, `social.reply.send`, `social.dm.send`, `social.comment.send`, `social.mention`, `social.repost`, `social.ad.boost`
  - [ ] Add preview cards showing exact final text/media, destination account, audience, timing, risk flags, and source rationale
  - [ ] Add diff view for edits between Trent draft and human-approved final
  - [ ] Add immutable audit log for every draft, edit, approval, publish, reply, failure, revoke, opt-out, and deleted/suppressed item
  - [ ] Add emergency stop: pause all scheduled social actions per company/account
  - [ ] Add social spend guard for boosted posts/ads; always approval-gated
  - [ ] Add "cannot do this" explanation when platform policy blocks an action
- [ ] **T18.8 — Social engagement quality & evals** 🧪 🎤
  - [ ] Build eval set: 100 social scenarios across X and Instagram
  - [ ] Score for brand voice, helpfulness, specificity, non-spamminess, policy compliance, and conversion intent
  - [ ] Add platform-policy red-team cases: harassment bait, political bait, medical/legal/financial advice, competitor claims, personal data requests
  - [ ] Add "would a human social operator approve this?" rubric
  - [ ] Add automated classifier for low/medium/high-risk replies; high-risk must fail closed
  - [ ] Add regression tests for no hallucinated claims, no fake testimonials, no unsupported metrics
  - [ ] Add review queue sampling: 5% of auto-low-risk drafts still sampled for human review
- [ ] **T18.9 — Social analytics & reporting** 🎤
  - [ ] Track per-post metrics: impressions, likes, replies/comments, profile clicks, link clicks, saves/shares where API allows
  - [ ] Track qualitative signals: questions asked, objections, feature requests, support themes, buying intent
  - [ ] Add weekly social report artifact: what posted, what worked, what to repeat, what to stop, lead follow-ups
  - [ ] Connect social signals to tasks, content calendar, CRM, product backlog, and company memory
  - [ ] Add experiment ledger: hypothesis, post variants, audience, CTA, result, next action
  - [ ] Add UTM generation and attribution handoff to PostHog/Stripe/HubSpot later
- [ ] **T18.10 — Social assets & media workflow** 🎤
  - [ ] Add media library for approved brand assets, screenshots, logos, founder photos, product clips
  - [ ] Add generated asset approval flow: image/video generated → human approves → eligible for post
  - [ ] Add alt text generator and accessibility checker
  - [ ] Add image/video crop validator per channel
  - [ ] Add carousel/story/reel planning support as drafts even before full API support
  - [ ] Link social posts to artifact builder outputs: competitive PDF, investor update snippet, dashboard screenshot, launch notes
- [ ] **T18.11 — Scheduling, queues, and reliability** 🔥
  - [ ] Add scheduled social job runner with idempotency keys
  - [ ] Add retry policy by failure type: rate limit, token expired, media processing, policy block, network failure
  - [ ] Add pre-publish validation five minutes before scheduled time
  - [ ] Add missed-post handling: ask user to reschedule, publish now, or cancel
  - [ ] Add account-level daily/weekly action caps below platform limits
  - [ ] Add timezone-aware scheduling and quiet-hour enforcement
  - [ ] Add webhook ingestion for mentions/comments/messages where platform allows
- [ ] **T18.12 — Packaging & trust copy** 💰 🎤
  - [ ] Product copy: "a supervised social operator, not a spam bot"
  - [ ] Explain transparent automation, approval gates, official APIs, opt-out handling, and audit logs
  - [ ] Add demo flow: Trent turns a weekly artifact into posts, drafts replies, flags a lead, asks for approval, publishes safely
  - [ ] Add pricing/credit model for social actions: drafts, approved publishes, inbox triage, analytics reports
  - [ ] Add setup checklist for X and Instagram accounts
  - [ ] Add customer education: how to avoid platform bans and keep brand trust

---

## E19 — Phase Gates (Do Not Skip)

> Each phase gate is a hard checkpoint. Don't move on until all boxes are ticked.

- [ ] **G1 — Phase 1 gate (end Q2 2026)**
  - [ ] Trigger.dev migration complete
  - [ ] Postgres + RLS verified by red-team test
  - [ ] Episodic memory writing on every cycle
  - [ ] Audit log surfaced in UI
  - [ ] 3-4 agents at supervised+ quality
  - [ ] Dogfood dashboard live publicly
- [ ] **G2 — Phase 2 gate (end Q4 2026)**
  - [ ] GitHub writes in production (real PRs)
  - [ ] Stripe billing live
  - [ ] Postmark send-on-approve live
  - [ ] Encrypted credential vault audited
  - [ ] First external pen test passed
  - [ ] 100 paying founders
  - [ ] SOC 2 Type I in hand or imminent
- [ ] **G3 — Phase 3 gate (end Q2 2027)**
  - [ ] Browserbase + Meta Ads in production
  - [ ] Agent lab MVP with regression gating
  - [ ] 5+ agents at autonomous quality
  - [ ] $50-150k MRR
  - [ ] SOC 2 Type I closed; Type II in progress
- [ ] **G4 — Phase 4 gate (Q4 2027+)**
  - [ ] SOC 2 Type II
  - [ ] EU region live
  - [ ] Third-party agent SDK in private beta
  - [ ] Sustained weekly eval regression passing across all autonomous agents

---

## Appendix A — DB Migration Watchlist

- [ ] Every RLS-bearing table has policies for SELECT/INSERT/UPDATE/DELETE
- [ ] Every PII column is encrypted at rest (envelope) or noted as non-PII
- [ ] Every new table has `created_at`, `updated_at`, `company_id` (where tenanted)
- [ ] Every foreign key has `ON DELETE` rules considered

## Appendix B — Anti-checklist (don't build these in 2026)

- [ ] ~~Agent marketplace~~ (2028+)
- [ ] ~~Custom VPC deployment~~ (gated on enterprise demand pull)
- [ ] ~~FedRAMP / HIPAA~~ (out of scope)
- [ ] ~~On-prem self-hosted~~ (out of scope until 2027 at earliest)
- [ ] ~~Per-seat pricing~~ (kills the "one hire" narrative)

---

_End of master task list — ed.02 · 2026-05-27._
_Re-issue when a Phase Gate clears or scope shifts more than one quarter._
