<div align="center">

# 🧑‍💼 Trent

### **The one hire who does it all.**

![typescript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)
![next](https://img.shields.io/badge/Next.js%2015-000?logo=nextdotjs&logoColor=white)
![prisma](https://img.shields.io/badge/Prisma%20%2B%20Postgres-2D3748?logo=prisma&logoColor=white)
![redis](https://img.shields.io/badge/BullMQ%20%2B%20Redis-DC382D?logo=redis&logoColor=white)
![llm](https://img.shields.io/badge/LLM-Anthropic%20%2B%20OpenAI-8A63D2)
![tests](https://img.shields.io/badge/tests-1731%20passing-brightgreen)
![typecheck](https://img.shields.io/badge/typecheck-0%20errors-brightgreen)
![license](https://img.shields.io/badge/license-MIT-blueviolet)

*Most "AI employee" demos are a chat box with a job title. This one has a budget,
an approval queue, and an audit log — because an agent you cannot stop, cannot
bill, and cannot review is not an employee. It is a liability.*

</div>

---

## 🧭 Read the status table first

Below is a table that says **Not-yet-wired** in three places. That is deliberate.

Nothing here is marked *Working* unless a named command proves it, and the command
is printed next to the claim so you can run it yourself. The roadmap section lists
what exists in code but has **not** been validated end-to-end — separately, and
honestly, rather than blended into the feature list.

If you only read one thing to judge this project, read those two tables.

---

**Full local setup:** [docs/RUN.md](docs/RUN.md) (authoritative). **Env reference:** [`.env.example`](.env.example).

---

## Current status

Honest snapshot — last verified **2026-06-07** on this tree. If a row is not backed by a passing check below, it is **not** marked Working.

| Surface | Status | What was verified |
|---------|--------|-------------------|
| **Command console** | Working | Runtime smoke eval (`command_reconnect` fixtures); requires `OPENAI_API_KEY` |
| **Workbench** | Working | Live E2B eval green (`npm run workbench:eval:live-cloud`); without `E2B_API_KEY`, falls back to **`mock_local`** (sandbox shell on host) |
| **Agent missions** | Sandbox-only | End-to-end eval green with sandbox platform adapters (`npm run runtime:eval -- --agent-mission-e2e --threshold 1`); default `PLATFORM_ACTION_MODE` ≠ `live` → simulated publishes/ads |
| **Provisioning** (GitHub → Neon → Vercel) | Not-yet-wired | Orchestrator + provisioners implemented + unit tests; **not** validated against real GitHub / Neon / Vercel accounts yet |
| **Autonomy / heartbeat** | Not-yet-wired | Routes and worker job types exist; not covered by smoke eval or CI cron validation |

### Quality gates (this repo)

| Gate | Command | Result (2026-06-07) |
|------|---------|---------------------|
| Typecheck | `npm run typecheck` | ✅ 0 errors |
| Tests | `npm test` | ✅ 1731 passed, 122 skipped |
| Runtime smoke | `npm run runtime:eval:smoke` | ✅ 20/20 fixtures |

Skipped tests are mostly DB-backed provisioning suites when `TEST_DATABASE_URL` is unreachable — see `lib/vitest-guards.ts`.

---

## Roadmap (not yet proven end-to-end)

These exist in code or docs but are **not** claimed as shipped until they pass real validation:

- Full provisioning stack beyond GitHub → Neon → Vercel (R2, DNS, Sentry, Render, Expo, teardown n8n workflows)
- Real social/ad publish (`PLATFORM_ACTION_MODE=live` + OAuth)
- Production cron heartbeat sweep on a live deploy
- Unattended overnight autonomy without manual triggers
- `backend/server.py` legacy split-port FastAPI ingress proxy (optional; **not** the default LLM path — see `lib/ai-client.ts` + `OPENAI_API_KEY`)

---

## What it is

- **9+ agent roles** — ceo · engineer · growth · content · support · analyst · finance · browser · escalation
- **Multi-agent orchestration** — planner generates a DAG, specialists execute steps, critic loops, consolidator writes the brief
- **Approval-first architecture** — no agent ships consequential work without explicit approval
- **Budget-aware** — hard spend caps, per-agent token budgets, `cmd+shift+.` kill switch
- **Live SSE streaming** — workbench timeline and command console animate in real time
- **Obsidian-style memory** — markdown notes, folders, backlinks, graph view, semantic search (embeddings: see Roadmap)
- **Heartbeat / autonomy** — API routes exist; production cron sweep **not yet validated** (see Current status)
- **Public company page** — `[company].trent.app` opt-in transparency dashboard
- **Audit log** — tamper-evident SHA-256 hash chain on every state change

---

## Run locally

Linux happy path (matches [docs/RUN.md](docs/RUN.md)). Repo path example: `~/Projects/trent`.

### Prerequisites

- **Node.js 22.x** (`package.json` `engines.node`)
- **npm** (project scripts use **npm**, not yarn)
- **Docker** (recommended) for Postgres + Redis

### 1. Install dependencies

```bash
cd ~/Projects/trent
npm install
```

### 2. Start Postgres and Redis

```bash
docker compose -f docker-compose.dev.yml up -d
```

| Service | Port | Credentials |
|---------|------|-------------|
| Postgres | 5432 | user `trent`, password `trentdev`, db `trent` |
| Redis | 6379 | no auth |

### 3. Configure `.env.local`

```bash
cp .env.example .env.local
```

Minimum for the happy path:

```bash
AUTH_SECRET="<openssl rand -base64 32>"
DATABASE_URL="postgresql://trent:trentdev@localhost:5432/trent"
DIRECT_URL="postgresql://trent:trentdev@localhost:5432/trent"
OPENAI_API_KEY="sk-..."
REDIS_URL="redis://localhost:6379"
NEXT_PUBLIC_APP_URL="http://localhost:3000"
```

- **LLM path:** `OPENAI_API_KEY` → `lib/ai-client.ts` (OpenAI-compatible API). Override models via `OPENAI_MODEL_*` in `.env.local` — see `.env.example`.
- Without `DATABASE_URL`: in-memory store (data lost on restart).
- Without `REDIS_URL`: in-process queue fallback in dev; `npm run worker` will not start.
- Env file must be **`.env.local`** with `KEY=value` syntax (not `KEY: value`).

### 4. Apply database schema

```bash
npm run prisma:generate
npx prisma db push
```

### 5. Start app + worker (two terminals)

```bash
# Terminal 1
npm run dev          # → http://localhost:3000

# Terminal 2 (requires REDIS_URL)
npm run worker
```

Sign in at `/auth/signin` → **Development Login** (local dev magic-email flow).

### 6. Verify

| Check | Command | Expected |
|-------|---------|----------|
| Health | `curl -s http://localhost:3000/api/health \| jq .` | `"readiness.db":"postgres"`; `"worker.alive":true` when worker running |
| Worker | `npm run worker:health` | Redis PING + recent heartbeat |
| LLM | Command or workbench prompt | Real model response (not `"OPENAI_API_KEY is not configured"`) |
| Typecheck | `npm run typecheck` | 0 errors |

See [docs/RUN.md](docs/RUN.md) for Supabase option, E2B workbench, agent missions, provisioning checklist, and troubleshooting.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│  Next.js 15  (port 3000)                                         │
│  ├─ /command   → command console + orchestrator reconnect        │
│  ├─ /workbench → autonomous IDE (mock_local · E2B · Daytona)     │
│  ├─ /wiki      → notes + graph                                   │
│  ├─ /companies/[id]/missions → agent missions + approval gates   │
│  ├─ /api/companies/[id]/orchestrate/stream  → SSE timeline      │
│  ├─ /api/companies/[id]/heartbeat           → per-company pulse  │
│  └─ /api/provisioning                       → GitHub→Neon→Vercel │
└─────────────────┬────────────────────────────────────────────────┘
                  │ OpenAI SDK (OPENAI_API_KEY / OPENAI_BASE_URL)
┌─────────────────▼────────────────────────────────────────────────┐
│  Postgres (Prisma) + Redis (BullMQ worker)                       │
└──────────────────────────────────────────────────────────────────┘
```

LLM calls go through `lib/ai-client.ts` with `OPENAI_API_KEY`. An optional legacy FastAPI ingress proxy lives under `backend/` for split-port preview setups, but it is **not** required for the documented happy path.

### Multi-agent orchestrator

```
PLANNER  ───►  TASK GRAPH  ───►  SPECIALISTS  ───►  CRITIC  ───►  CONSOLIDATOR
(GPT-5.2)      (DAG w/ deps)     (Claude 4.5)      (Claude)        (Claude)
                                  • engineer
                                  • analyst
                                  • growth
                                  • content
                                  • finance
                                  • browser
                                  • support
                                  • escalation
                                  • ceo
```

Each run flows through `planning → running → completed | failed | cancelled`, with optional `step approval` gates pausing execution until a founder clicks ✓.

---

## Environment variables

Copy `.env.example` → `.env.local`. **`.env.example` is authoritative.**

| Variable | Required (happy path) | Purpose |
|----------|----------------------|---------|
| `AUTH_SECRET` | ✅ | NextAuth v5 session signing |
| `DATABASE_URL` + `DIRECT_URL` | ✅ | Postgres via Prisma |
| `OPENAI_API_KEY` | ✅ | LLM (`lib/ai-client.ts`) |
| `REDIS_URL` | ✅ | BullMQ worker + durable queue |
| `SECRET_ENCRYPTION_KEY` | prod | 64-char hex for stored credentials |
| `E2B_API_KEY` / `DAYTONA_API_KEY` | — | Real cloud workbench (else `mock_local`) |
| `GITHUB_APP_*`, `NEON_API_KEY`, `VERCEL_*` | — | Provisioning (not yet real-validated) |

> ⚠️ Never commit `.env.local` or any real credentials. Full tables: [docs/RUN.md](docs/RUN.md).

---

## Key API routes

### Orchestration
| Route | Purpose |
|-------|---------|
| `POST /api/companies/:id/orchestrate` | Launch an autonomous multi-step run |
| `GET  /api/companies/:id/orchestrate` | List runs |
| `GET  /api/companies/:id/orchestrate?runId=X` | Fetch one run + steps |
| `GET  /api/companies/:id/orchestrate/stream?runId=X` | **SSE live timeline** |
| `POST /api/companies/:id/orchestrate/approve` | Approve a `needsApproval` step |
| `DELETE /api/companies/:id/orchestrate?runId=X` | Cancel a run |

### Autonomy
| Route | Purpose |
|-------|---------|
| `POST /api/companies/:id/heartbeat` | Per-company a competing product-style heartbeat |
| `POST /api/heartbeat/sweep` | **Cron-callable** sweep across all active companies (Bearer `CRON_SECRET`) |

### Wiki / Memory
| Route | Purpose |
|-------|---------|
| `POST /api/companies/:id/wiki-notes` | Create/update markdown note (auto-parses `[[links]]` + `#tags`) |
| `GET  /api/companies/:id/wiki-notes` | List notes + folder tree |
| `GET  /api/companies/:id/wiki-notes?view=graph` | Knowledge graph |
| `POST /api/companies/:id/wiki-notes/upload` | File upload (`.md` / `.pdf` / `.csv` / `.json` / `.txt`) |
| `POST /api/companies/:id/wiki/semantic` | **Vector-embedded semantic search** |

### Workbench
| Route | Purpose |
|-------|---------|
| `POST /api/workbench` | Create a sandbox session (provider: `mock_local` · `e2b` · `daytona`) |
| `POST /api/workbench/:id/exec` | Run a shell command |
| `POST /api/workbench/:id/files` | Read/write files |
| `POST /api/workbench/:id/screenshot` | Capture a screenshot |
| `POST /api/workbench/:id/tests` | Run the project's tests |
| `GET  /api/workbench/:id/events` | SSE event stream |

### Existing
| Route | Purpose |
|-------|---------|
| `POST /api/companies/:id/cycles` | Trigger a cycle |
| `GET  /api/jobs/events?companyId=X` | SSE stream for live cycle progress |
| `POST /api/jobs/:id/cancel` | Kill a running job |
| `POST /api/integrations/github` | Save encrypted GitHub credentials |
| `GET  /api/usage?companyId=X` | Spend summary |
| `GET  /api/health` | Liveness probe |

---

## Cron scheduling

Heartbeat sweep is designed to be hit on a 1–6h cadence by **Vercel Cron** (or any external scheduler). Configuration lives in `vercel.json`:

```jsonc
{
  "crons": [
    { "path": "/api/heartbeat/sweep",      "schedule": "0 */3 * * *" },
    { "path": "/api/jobs/scheduler/sweep", "schedule": "*/15 * * * *" }
  ]
}
```

Set `CRON_SECRET` in your Vercel env so unauthenticated cron callers can still authenticate via `Authorization: Bearer ${CRON_SECRET}`.

---

## Cloud sandbox providers

Workbench provider selection (`lib/workbench-providers.ts`):

1. `WORKBENCH_DEFAULT_PROVIDER=e2b|daytona|mock_local` (explicit)
2. `E2B_API_KEY` set → E2B
3. `DAYTONA_API_KEY` set → Daytona
4. Default → `mock_local` (sandboxed host shell)

Real E2B proof:

```bash
npm run workbench:eval:live-cloud -- --env-file .env.local
```

Requires `E2B_API_KEY` + `OPENAI_API_KEY`. Without cloud keys, workbench stays **sandbox-only** on the host.

---

## Vector memory (wiki)

Wiki notes support folders, `[[backlinks]]`, tags, and semantic search when embeddings are configured. Embedding storage depends on environment (dev file vs Postgres `pgvector`). See `lib/wiki-embeddings.ts` — treat production RAG as **roadmap** until validated on your deploy.

---

## Deploy

```bash
npm run build && npm start
```

Or Vercel — set all env vars from `.env.example` in project settings first.

---

## Stack

- **Next.js 15** — App Router, TypeScript strict
- **Prisma + Postgres** — `prisma/schema.prisma`; in-memory fallback when `DATABASE_URL` unset
- **NextAuth v5** — Credentials + optional Google OAuth
- **BullMQ + Redis** — background worker (`npm run worker`)
- **OpenAI SDK** — `OPENAI_API_KEY` via `lib/ai-client.ts`
- **E2B / Daytona** — optional cloud workbench providers

---

## Project layout

```
app/                   Next.js routes + API handlers
  ├─ companies/[id]/   per-company workspaces (command · workbench · wiki · …)
  └─ api/              REST + SSE endpoints
components/            shell, sub-pages, UI primitives
  ├─ devin-workbench-client.tsx       Devin-style 3-pane IDE
  ├─ claude-style-command-client.tsx  Claude-style command console
  └─ obsidian-wiki-client.tsx         Obsidian-style wiki
lib/
  ├─ orchestrator.ts        planner → DAG → executor → critic → consolidator
  ├─ heartbeat.ts           a competing product-style autonomous heartbeat
  ├─ wiki-notes.ts          Obsidian-style notes (paths, backlinks, tags)
  ├─ wiki-embeddings.ts     vector memory + semantic search
  ├─ orchestrator-events.ts SSE event stream
  ├─ workbench.ts           workbench session lifecycle
  ├─ workbench-provider.ts  provider adapter interface
  ├─ workbench-e2b-provider.ts     real E2B integration
  └─ workbench-daytona-provider.ts real Daytona integration
backend/
  ├─ server.py              FastAPI OpenAI-compatible bridge
  └─ requirements.txt
prisma/                Prisma schema + migrations
```

---

## GitHub integration

Save per-company encrypted credentials:

```http
POST /api/integrations/github
Body: { companyId, token, owner, repo }
```

Tokens are encrypted with `SECRET_ENCRYPTION_KEY` and never returned in API responses.

After approval, Engineer tasks can create GitHub issues and PR scaffolds:

```http
POST /api/tasks/:id/github-issue
POST /api/tasks/:id/github-pr-scaffold
```

---

## Security

- All secrets encrypted at rest via `SECRET_ENCRYPTION_KEY`
- Kill switch (`cmd+shift+.`) halts agent execution at every step boundary
- Tamper-evident audit log (SHA-256 chain) on every state change
- Approval queue gates all consequential actions before execution
- Step-level approvals on multi-agent runs (see `/api/companies/:id/orchestrate/approve`)
- `mock_local` shell allowlist + path-traversal guards
- See [SECURITY.md](SECURITY.md) for responsible disclosure

---

*trent · the one hire*