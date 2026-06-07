# Run Trent locally (Linux)

Single happy path from zero to a running dev server on Linux. Repo path assumed: `~/Projects/trent`.

**Authoritative env reference:** copy [`.env.example`](../.env.example) → `.env.local` and fill placeholders. Do not commit `.env.local`.

Agent context paths: see [`CLAUDE.md`](../CLAUDE.md) (Linux: `~/Projects/trent/…`).

---

## Prerequisites

- **Node.js 22.x** (`package.json` `engines.node`)
- **npm** (project scripts use npm, not yarn)
- **Docker** (recommended) for Postgres + Redis, or Supabase + Upstash accounts

---

## 1. Install dependencies

```bash
cd ~/Projects/trent
npm install
```

---

## 2. Start Postgres and Redis

### Option A — Docker Compose (recommended)

```bash
docker compose -f docker-compose.dev.yml up -d
```

Services:

| Service  | Port | Credentials        |
|----------|------|--------------------|
| Postgres | 5432 | user `trent`, password `trentdev`, db `trent` |
| Redis    | 6379 | no auth            |

Verify:

```bash
docker compose -f docker-compose.dev.yml ps
```

### Option B — Supabase Postgres

Create a project in the Supabase dashboard. Copy both connection strings from **Project → Connect**:

- `DATABASE_URL` — transaction pooler (port **6543**, `?pgbouncer=true`)
- `DIRECT_URL` — direct session connection (port **5432**)

Use Supabase Redis or any hosted Redis for `REDIS_URL` in step 3.

---

## 3. Configure `.env.local`

```bash
cp .env.example .env.local
```

Minimum for the happy path (Docker option A):

```bash
# Auth — generate: openssl rand -base64 32
AUTH_SECRET="<paste-generated-secret>"

# Database
DATABASE_URL="postgresql://trent:trentdev@localhost:5432/trent"
DIRECT_URL="postgresql://trent:trentdev@localhost:5432/trent"

# LLM — required for any agent/workbench LLM call
OPENAI_API_KEY="sk-..."

# Background jobs
REDIS_URL="redis://localhost:6379"

# App URL (NextAuth trustHost is enabled; useful for OAuth callbacks)
NEXT_PUBLIC_APP_URL="http://localhost:3000"
```

**Optional but recommended**

```bash
# Encryption for stored credentials (generate: openssl rand -hex 32)
SECRET_ENCRYPTION_KEY="<64-char-hex>"

# Model overrides — only if defaults 404 on your OpenAI account (see .env.example comments)
# OPENAI_MODEL_STRONG="gpt-4.1"
# OPENAI_MODEL_CODING="gpt-4.1-mini"
```

**Google sign-in (optional):** set `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`, and `NEXT_PUBLIC_HAS_GOOGLE=true`.

Without `DATABASE_URL`, the app uses an **in-memory store** (data lost on restart). Without `OPENAI_API_KEY`, LLM calls throw `"OPENAI_API_KEY is not configured"`. Without `REDIS_URL`, the worker cannot start (jobs fall back to in-process mode in dev).

> **Important:** the env file must be named **`.env.local`** (not `trent.env.local`). Every line must use `KEY=value` syntax (`DATABASE_URL=...`, not `DATABASE_URL:...`).

---

## 4. Data persistence — in-memory vs Postgres

Trent picks its storage backend once at startup in `lib/store.ts`:

```ts
export const store = process.env.DATABASE_URL ? prismaStore : memStore;
```

| `DATABASE_URL` | Store | Persists across restart? |
|----------------|-------|-------------------------|
| **Unset or empty** | `memStore` (`lib/mem-store.ts`) | **No** — all companies, tasks, workbench sessions reset |
| **Set** (Postgres URL) | `prismaStore` (`lib/prisma-store*.ts` → Prisma) | **Yes** — written to Postgres via `lib/db.ts` |

Related behavior:

- **`lib/session.ts`**: when `DATABASE_URL` is unset, `canAccessCompany()` always returns `true` (demo mode). With Postgres, real `CompanyMember` rows are required.
- **`lib/with-rls.ts` / `lib/rls.ts`**: RLS policies apply only when `DATABASE_URL` starts with `postgres`.
- **Queue fallback**: without `REDIS_URL`, `lib/queue.ts` runs jobs in-process (`[Queue Fallback]` logs) instead of BullMQ — still uses whichever `store` is active, but no separate worker process.

**Verify persistence**

1. Set `DATABASE_URL` and `DIRECT_URL` in `.env.local` (fix any `:` → `=` typos).
2. Apply schema (step 5 below).
3. `npm run dev` → sign in → create a company or workbench session.
4. Stop dev (`Ctrl+C`) and start again — data should still be there.
5. `curl -s http://localhost:3000/api/health | jq .readiness.db` → `"postgres"`.

---

## 5. Prisma — generate and apply schema

`prisma/schema.prisma` targets **PostgreSQL** (`provider = "postgresql"`). It reads:

- `DATABASE_URL` — runtime app + Prisma client
- `DIRECT_URL` — migrations / `db push` (direct connection; use Supabase port 5432, not the pooler)

**Fresh Postgres (empty database) — quickest path**

```bash
npm run prisma:generate
npx prisma db push
```

**Existing migrations in repo (recommended for prod-like local)**

```bash
npm run prisma:generate
npx prisma migrate deploy
```

Use `npm run prisma:migrate` when authoring new migrations during development.

**SQLite-era note (`trent.db` / `trent-test.db`)**

Older docs referenced SQLite files. This tree is Postgres-only. Adapt the old rule as:

| Role | Env var | Example |
|------|---------|---------|
| App / dev | `DATABASE_URL` + `DIRECT_URL` | Neon, Supabase, or Docker Compose Postgres |
| Vitest | `TEST_DATABASE_URL` + `TEST_DIRECT_URL` | Separate disposable DB (name should include `test`) |

Never point `TEST_DATABASE_URL` at the same database as `DATABASE_URL` unless the URL path clearly contains `test` (see `lib/test-database-env.ts`).

Example test env:

```bash
export TEST_DATABASE_URL="postgresql://trent:trentdev@localhost:5432/trent_test"
export TEST_DIRECT_URL="postgresql://trent:trentdev@localhost:5432/trent_test"
npx prisma db push   # once, against TEST_DATABASE_URL if you run DB-backed tests
```

Confirm Postgres is selected at runtime:

```bash
curl -s http://localhost:3000/api/health | jq '.readiness.db, .checks.database'
```

---

## 6. Background jobs — Redis, worker, job types

### Redis + worker

Terminal 2 (requires `REDIS_URL` in `.env.local`):

```bash
npm run worker
```

Expected logs:

```
Starting BullMQ worker on queue "trent-autonomy-queue"...
[Worker] Connected to Redis; consuming queue "trent-autonomy-queue"
```

Worker health check (Redis ping + queue counts + last heartbeat):

```bash
npm run worker:health
```

The worker writes `trent:worker:heartbeat` to Redis every 10s (30s TTL). Health exposes it:

```bash
curl -s http://localhost:3000/api/health | jq .worker
# { "seenAt": "2026-...", "alive": true }
```

If `REDIS_URL` is missing, the worker exits immediately:

```
Error: REDIS_URL is not set. Worker cannot start.
```

Without Redis, the Next.js process still enqueues via **in-process fallback** (`[Queue Fallback]` in logs) — fine for quick dev, but no separate worker and no heartbeat.

### BullMQ job types (`lib/worker.ts` → `lib/queue.ts`)

| Job type | Trigger | What it does |
|----------|---------|--------------|
| `scheduled_cycle_sweep` | `POST /api/jobs/scheduler` (cron secret or authed user); `POST /api/companies/[id]/schedule` | Finds companies with due cycles and runs `runDueScheduledCycles()` |
| `company_scheduled_cycle` | `POST /api/companies/[id]/cycles` (Run cycle) | Runs one company operating cycle via `runCompanyCycle()` |
| `recurring_task_materialization` | `POST /api/companies/[id]/schedule` (recurring action) | Materializes due recurring task templates into real tasks |
| `workbench_session_sweep` | `enqueueWorkbenchSessionSweep()` (no cron route wired yet — call from REPL/tests) | Terminates idle/timed-out workbench sandboxes via `workbenchSessionSweep()` |
| `run_subtask` | Orchestrator / plug runtime / supervision approval (`enqueueSubtaskRun`) | Executes one specialist subtask via `processSubtaskJob()` |
| `wiki_index_refresh` | Workbench event POST (`/api/workbench/[id]/events`) when reindex needed | Refreshes Trench Wiki index via `runWikiIndexRefresh()` |
| `platform_action` | Agent mission executor after approval (`agent_mission_platform_action`) | Runs queued social/ad platform action via `executeQueuedPlatformAction()` |
| `content_performance_ingest` | Content performance feedback loop (`lib/content/performance-feedback.ts`) | Ingests content/ad performance metrics for mission feedback |

**Trigger a job locally (example — cycle sweep)**

```bash
curl -X POST http://localhost:3000/api/jobs/scheduler \
  -H "Cookie: <your session cookie>"
```

Watch the worker terminal for `[Worker] Received job ...` and `[Worker] Job ... completed`.

---

## 7. Start the app

Terminal 1 — Next.js dev server:

```bash
npm run dev
```

Terminal 2 — BullMQ worker (requires `REDIS_URL`):

```bash
npm run worker
```

(See **§6 Background jobs** for `worker:health`, job types, and heartbeat.)

---

## 8. Verify

| Check | Command | Expected |
|-------|---------|----------|
| Dev server | Open `http://localhost:3000` | App loads |
| Health | `curl -s http://localhost:3000/api/health \| jq .` | `"readiness.db":"postgres"`, `"worker.alive":true` when worker running |
| Worker | `npm run worker:health` | `Redis PING: PONG`, recent heartbeat timestamp |
| Persistence | Restart `npm run dev` after creating data | Data still present |
| Sign in | `/auth/signin` → Development Login | Session created |
| LLM | Command or workbench prompt | Real model response (not "OPENAI_API_KEY is not configured") |

**Health endpoint note:** `/api/health` returns HTTP **503** with `"status":"degraded"` when `BACKUP_DIR` is unset (backup probe fails). App and database checks still pass. Set `BACKUP_DIR` only if you run encrypted Postgres backups locally.

Example healthy-enough response (database ok, backup degraded):

```json
{
  "status": "degraded",
  "checks": { "app": "ok", "database": "ok" },
  "backup": { "ok": false, "error": "..." }
}
```

For HTTP **200**, configure `BACKUP_DIR` to a directory containing a recent `.dump.enc` backup (production concern).

---

## 9. Typecheck (before committing)

```bash
npm run typecheck
```

---

## Environment variable summary

See [`.env.example`](../.env.example) for the full annotated list. Quick reference:

### Required for happy path

| Variable | Purpose |
|----------|---------|
| `AUTH_SECRET` | NextAuth v5 JWT signing (`lib/auth.ts`) |
| `DATABASE_URL` | Postgres app connection (`lib/store.ts`, Prisma) |
| `DIRECT_URL` | Prisma migrations (`prisma/schema.prisma`) |
| `OPENAI_API_KEY` | All LLM calls via `lib/ai-client.ts` |
| `REDIS_URL` | BullMQ worker + durable queue |

### Boots without (degraded)

| Variable | When missing |
|----------|----------------|
| `DATABASE_URL` | In-memory store; `canAccessCompany` always true in dev |
| `OPENAI_API_KEY` | App boots; LLM routes throw on use |
| `REDIS_URL` | In-process queue fallback in dev; worker won't start |
| `SECRET_ENCRYPTION_KEY` | Dev default key in `lib/secrets.ts` |
| `BACKUP_DIR` | `/api/health` returns 503 degraded |

### Auth naming (NextAuth v5)

Code reads **`AUTH_SECRET`** first, then **`NEXTAUTH_SECRET`**. README’s old `NEXTAUTH_SECRET`-only table is superseded by `.env.example`.

Google sign-in uses **`AUTH_GOOGLE_ID`** / **`AUTH_GOOGLE_SECRET`**. Platform YouTube/OAuth uses **`GOOGLE_CLIENT_ID`** / **`GOOGLE_CLIENT_SECRET`** (separate concern).

### Default LLM models (`lib/ai-client.ts`)

| Env override | Default model | Availability |
|--------------|---------------|--------------|
| `OPENAI_MODEL_FAST` | `gpt-4.1-nano` | Real OpenAI API model |
| `OPENAI_MODEL_DEFAULT` / `OPENAI_MODEL` | `gpt-4.1-mini` | Real OpenAI API model |
| `OPENAI_MODEL_STRONG` | `gpt-5.2` | Real OpenAI API model |
| `OPENAI_MODEL_CODING` / `WORKBENCH_PLANNER_MODEL` | `gpt-5.2-codex` | Real OpenAI API model |
| `OPENAI_MODEL_CRITIC` | `gpt-5.2` | Real OpenAI API model |

All defaults are overridable via the env vars above — do not change code defaults; set overrides in `.env.local` if your API account lacks a model.

---

## Workbench cloud sandbox (E2B)

Provider selection (in order):

1. Explicit `WORKBENCH_DEFAULT_PROVIDER=e2b|daytona|mock_local`
2. `E2B_API_KEY` set → **E2B** (`lib/workbench-providers.ts` → `getDefaultWorkbenchProvider()`)
3. `DAYTONA_API_KEY` set → Daytona
4. Dev/test fallback → `mock_local` (`lib/workbench.ts` → `resolveWorkbenchSessionProvider()`)

**E2B env vars** (read by `lib/workbench-e2b-provider.ts` via `resolveWorkbenchProviderCredentialEnv`):

| Variable | Required | Purpose |
|----------|----------|---------|
| `E2B_API_KEY` | Yes | Sandbox auth (platform env or per-company integration) |
| `E2B_TEMPLATE` | No | Sandbox template (default `base`) |
| `E2B_SANDBOX_TIMEOUT_MS` | No | Max sandbox lifetime (default 30 min) |
| `E2B_EXEC_TIMEOUT_MS` | No | Default command timeout (default 5 min) |

**Minimum for a real build + preview in the UI:**

```bash
OPENAI_API_KEY="sk-..."
E2B_API_KEY="..."
# optional: WORKBENCH_DEFAULT_PROVIDER=e2b
```

Flow: create workbench session → `POST /api/workbench/:id/messages` → `runWorkbenchAgent` → `runBuildLoop` (plan → file writes → shell → `startPreview` → verify → screenshot artifact).

**Approval gates:** `git push`, `npm publish`, and deploy-class commands are blocked at the provider (`requiresApproval` in `lib/workbench-safety.ts`). The agent loop pauses the session (`status: paused`) and creates a pending `Approval` — it does not continue after logging alone.

**Live cloud proof eval:**

```bash
npm run workbench:eval:live-cloud -- --env-file .env.local
```

Requires `E2B_API_KEY` or `--provider e2b`. Prints JSON with `passed`, `previewUrl`, `screenshotStorageKey`, and command results (no secret values).

---

## Agent mission — content publish end-to-end

**Mission:** `content_social_ads` agent mission (`lib/agent-mission-runtime.ts`) — research → content → publish (X/social) → reply → Meta ads → CEO report.

| Layer | Location |
|-------|----------|
| UI | `app/companies/[id]/missions/page.tsx` → `components/agent-mission-client.tsx` |
| Start | `POST /api/companies/[id]/agent-missions` → `runAgentMission()` |
| Approvals | `createApprovalRequests()` → resolve via `PATCH /api/approvals/[id]` → `syncAgentMissionForApproval()` |
| Execute | `executeApprovedAgentMissionAction()` → `executeQueuedPlatformAction()` |

**Platform mode:** unset `PLATFORM_ACTION_MODE` (default) → **sandbox** adapters with `Simulated (sandbox)` badges in the missions UI. Set `PLATFORM_ACTION_MODE=live` for real OAuth-backed publishes/ads.

**Audit trail:** `agent_mission.run_started`, `agent_mission.approval_requested`, `agent_mission.approval_resolved`, `agent_mission.platform_action_*` via `lib/agent-mission-audit.ts` → company audit log.

**Spend caps:** mission start calls `assertAgentMissionBudget()`; paid ad launch reserves via `assertToolSpendAllowed("agent_mission.ads.launch", dailyBudgetCents)`.

**Mission e2e eval:**

```bash
npm run runtime:eval -- --agent-mission-e2e --threshold 1
```

**Hand verification (sandbox — default):**

1. `npm run dev` (+ worker if using async queue; approval hook auto-runs platform actions synchronously).
2. Sign in → open `/companies/{companyId}/missions`.
3. Connect X + Meta in platform settings (tokens can be dummy for sandbox).
4. Enter objective: *Research trends, make content, publish to X after approval, reply to comments, launch Meta ads, report to CEO.*
5. Click run → trace shows `awaiting_approval` and approval cards.
6. Approve each gate (public publish, reply, sales send, paid spend).
7. Confirm: provider actions show `[Simulated]` labels; posts have `sandbox_*` external IDs; **platform mode** metric reads `Simulated (sandbox)`; audit log entries exist (`GET /api/companies/{id}/audit` or Prisma Studio).

**Live publish (optional):** set `PLATFORM_ACTION_MODE=live` and real OAuth tokens via platform connections (`saveSocialPlatformConnection`, `saveMarketingPlatformConnection`).

---

## Provisioning (GitHub → Neon → Vercel)

**Status:** code + unit tests only — **not yet validated** against real GitHub / Neon / Vercel accounts.

Orchestrator: `lib/provisioning/orchestrator.ts` (order: GitHub repo → Neon project → Vercel project). API: `POST /api/provisioning` (admin RBAC).

Required env vars (see `.env.example`):

| Variable | Provider |
|----------|----------|
| `SECRET_ENCRYPTION_KEY` | Stores encrypted integration records |
| `GITHUB_APP_ID`, `GITHUB_APP_INSTALLATION_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_PLATFORM_ORG` | GitHub |
| `NEON_API_KEY` | Neon |
| `VERCEL_TOKEN`, `VERCEL_TEAM_ID` (if team-scoped) | Vercel |

Pre-flight: `GET /api/provisioning?companyId=…` → all null. Use a unique `companySlug`. Rollback test: break `VERCEL_TOKEN`, confirm GitHub repo + Neon project are removed on failure (`failedAt: "hosting"`).

---

## Troubleshooting

| Symptom | Likely cause |
|---------|----------------|
| Workbench “does nothing” after add objective | LLM key missing or API error swallowed (WS-2 will surface errors) |
| Data resets on restart | No `DATABASE_URL`, wrong filename (`trent.env.local`), or `DATABASE_URL:` typo (`:` not `=`) |
| Missions never run | Worker not running or no `REDIS_URL` |
| `prisma migrate` fails | Wrong `DIRECT_URL` or Postgres not up |
| Model 404 from OpenAI | Override `OPENAI_MODEL_*` in `.env.local` |
