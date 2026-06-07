# System Architecture

Related: [[deploy-runbook]] [[roadmap]]

---

## Overview

```
Browser (Next.js client)
    ↓  fetch / SSE
Next.js App Router (API routes + RSC)
    ↓  Prisma
Database (SQLite dev / Neon Postgres prod)
    ↓
Agent runners (background workers)
    ↓  Anthropic SDK / OpenAI SDK
LLM APIs (Claude, GPT, Gemini)
    ↓
Tool adapters (GitHub, Stripe, Resend, PostHog, Cloudflare…)
```

## Request flow — cycle trigger

1. User clicks "Run cycle" or nightly cron fires
2. POST `/api/companies/:id/cycles` → creates `JobRun` row
3. Worker picks up job from queue
4. Worker calls `runCycle(companyId)`:
   a. Loads open tasks + agent configs
   b. Spins agent runners in parallel (one per role)
   c. Each runner calls LLM with role system prompt + task context
   d. LLM output → tool calls → tool adapters execute
   e. Results written to `Task`, `AuditLog`, `UsageLedgerEntry`
   f. Approval requests written to `Approval` table
5. Worker writes morning briefing to `Report`
6. SSE feed pushes events to browser

## Request flow — Workbench session

1. POST `/api/workbench` → creates `WbSession`
2. Client opens SSE at `/api/app-builder/runs/:id/stream`
3. Agent runner streams `AgentChunk` events:
   - `status` → phase label update
   - `plan` → plan steps displayed
   - `file` → file tree update + diff view
   - `command` → terminal output
   - `test` → test results
   - `preview` → sandbox URL
   - `done` → session complete
4. On `approval_required` event: runner pauses, writes `Approval` row
5. Human approves → runner resumes

## Multi-tenancy

- Every DB row has `companyId` FK
- Every API route calls `withRlsContext(companyId, ...)` before any DB access
- On Postgres, this sets `app.current_company_id` → RLS policies enforce isolation
- On SQLite (dev), `withRlsContext` is a no-op; dev has single-tenant data anyway

## Secret handling

```
Credential stored → encrypted with SECRET_ENCRYPTION_KEY → stored in DB
          ↓
Agent needs credential
          ↓
env-manager.buildProvisioningEnv(companyId, { providers: [...] })
          ↓
resolveCredentialEnv → decrypt → inject as env var into agent runner
          ↓
LLM never sees the raw value; only the tool adapter does
```

## Streaming architecture

- Workbench: `ReadableStream` → SSE via `EventSource`
- Cycle events: separate SSE endpoint `/api/jobs/events?companyId=`
- Fallback: client polls every 5s if SSE fails after 4 reconnect attempts

## Known limitations

- SQLite has write contention under parallel cycles (pre-existing, fixed in prod with Postgres)
- No horizontal scaling of workers yet (single worker instance)
- Marketplace agent sandboxing uses mock isolation; real WASM sandbox in roadmap
