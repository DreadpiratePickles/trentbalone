# Trent — Product Requirements Document

> Living document. Last updated: 2026-01-02 (v1.1).

## Origin & Problem Statement

User priorities: B (Devin workbench) > E (orchestration) > A (Claude console) > C (a competing product autonomy) > D (Obsidian wiki). Model choice: mix (Claude + GPT + Gemini). LLM key: the AI platform universal key, exposed as OpenAI-compatible.

## What's Implemented (v1.1, 2026-01-02)

### Task B — Devin-style Workbench ✅
- `components/devin-workbench-client.tsx` — 3-pane UI (timeline, workspace, reasoning rail)
- 7 workspace tabs · live SSE polling · plan-and-run composer
- **Step-level approval gates** with ✓ approve / ✕ reject buttons in the reasoning rail

### Task E — Pristine Multi-Agent Orchestration ✅
- `lib/orchestrator.ts` — planner → DAG → specialists → critic → consolidator
- **Approval gating**: `needsApproval=true` steps pause runLoop until founder clicks approve/reject
- `lib/orchestrator-events.ts` — in-process pub/sub event bus
- **SSE stream**: `GET /api/companies/[id]/orchestrate/stream?runId=X` emits real-time events
- `POST /api/companies/[id]/orchestrate/approve` — body `{runId, stepId, decision}`

### Task A — Claude-style Command Console ✅
- Ask / Agent / Autonomous mode pills · model picker · serif greeting · pill composer

### Task C — a competing product-style Autonomy ✅
- `lib/heartbeat.ts` decision logic
- `/api/heartbeat/sweep` cron-callable; middleware allow-listed
- **`vercel.json`** with crons: `/api/heartbeat/sweep` every 3h + scheduler every 15m
- `lib/agents.ts` — system prompt enhanced with "push back on bad ideas"

### Task D — Obsidian-style Wiki ✅
- Vault tree, [[backlinks]], #tags, knowledge graph, markdown editor, file uploads
- **Vector embeddings** auto-indexed on note save (`lib/wiki-embeddings.ts`)
- **Semantic search**: `POST /api/companies/[id]/wiki/semantic` returns top-K + Claude-grounded answer with `[#1]` citations
- Backend bridge now exposes `/v1/embeddings` (text-embedding-3-small shape, 384-dim)

### Infra ✅
- `backend/server.py` — FastAPI OpenAI-compatible bridge to Claude/GPT/Gemini
- Workbench providers: `mock_local` (default) · `e2b` (auto-loads when `E2B_API_KEY` set) · `daytona`
- `WORKBENCH_DEFAULT_PROVIDER` env flips the default

## Validated In Session
- ✓ Real-time SSE stream emits `snapshot → plan_end → step_start → ... → run_done`
- ✓ 7-step DAG produced for "send investor email" with 2 `needsApproval` steps (escalation + engineer)
- ✓ Approval API releases blocked step (`s4 blocked → running` after POST /approve)
- ✓ Semantic wiki search returns Claude-grounded answer with inline `[#1]` citations
- ✓ Embeddings endpoint returns 384-dim normalized vectors

## Backlog (P1)
- Streaming chat tokens in Claude console (current = full response)
- Drag-and-drop folder reorg in vault
- Persist orchestrator runs to MongoDB
- Workbench `e2b.getHost(port)` SDK call once `E2B_API_KEY` provided
- Real cloud-browser screenshots (Kernel SDK)

## Backlog (P2)
- Multi-model routing per step (Claude code for engineer, GPT-5.2 plan for ceo, Gemini for research)
- Note-rename preserves backlinks (path-aware refactor)
- Per-agent token budget visualization

## How to Run
```
sudo supervisorctl restart all
# Bridge → http://localhost:8001/v1
# App    → http://localhost:3000
# Sign in: /auth/signin → email = demo@trent.app → submit
```
