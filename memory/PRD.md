# Trent — Next-Level Master Plan Implementation (PRD / Progress)

## Original problem statement
Implement the "Trent Next-Level Master Plan" (cursor-trent-next-level-master-plan.md) on the
EXISTING Trent codebase, keeping its stack unchanged (Next.js 15 + TypeScript + Prisma/Postgres +
Redis/BullMQ). Three sections: §1 Orchestration audit fixes, §2 The Goal Loop (centerpiece),
§3 Self-improvement + client skills + client MCP. LLM = Anthropic Claude via the the AI platform
universal key. Go above and beyond; make it exemplary.

## Environment notes (important)
- Container resets wipe system packages under /usr but keep /app. Postgres + Redis are hosted from
  `/app/.runtime` via `scripts/start-services.sh` (idempotent; reinstalls binaries + restarts if a
  reset wiped them). Run it whenever the DB/redis are down.
- `backend/server.py` is a FastAPI reverse proxy (port 8001 → Next.js 3000) so the K8s `/api`→8001
  ingress reaches Next.js route handlers. `frontend/package.json` launches `next dev` from /app.
- Claude via the AI platform bridge wraps JSON in ```fences/preamble → `stripJsonFences` in
  `lib/ai-client.ts` makes all JSON parsing robust (fixes seat tool-use + planner parsing app-wide).

## Architecture delivered this iteration

### §2 The Goal Loop (centerpiece — COMPLETE, working E2E)
- Prisma `Goal` model (objective, successCriteria[], constraints, rounds[], progressLog[], costCents).
- `lib/goal-types.ts` — Zod contracts for goal, criteria, rounds, intake, round plan, CEO review.
- `lib/goal-store.ts` — validated CRUD via Prisma; the Goal IS the external memory.
- `lib/goal-intake.ts` — CEO model turns a command into measurable criteria + budget (repair-retry).
- `lib/goal-loop.ts` — `runGoalRound`: criteria-first planner → DAG pool execute (concurrency-capped)
  → artifact-first persistence (no prose passes) → evidence-based critic → CEO goal review that flips
  criteria to `met` ONLY with evidence artifact ids → rounds/progress ledger + next-round proposal.
- API: `goals` (GET/POST intake), `goals/[goalId]` (GET/PATCH approve/edit/stop),
  `goals/[goalId]/rounds` (POST run next round). Tenant-guarded (auth → RBAC).
- UI: `components/goal-cockpit.tsx` + `/companies/[id]/goals` page + nav entry. Criteria checklist
  with evidence links, rounds timeline, progress log, Human Gates (approve criteria / run round / stop).
- PROVEN: demo goal ran 3 rounds, 2/5 criteria flipped to MET with evidence, 1 BLOCKED (live URL
  needs workbench), budget tracked.

### §1 Orchestration audit (P0-2 + P0-3 — DONE)
- `lib/operating-state.ts` — `buildOperatingStateBundle`: open/stale tasks w/ age, last cycle,
  pending approvals, budget remaining vs burn, `recallRelevantMemory()`; token-capped sections.
- `lib/llm-json.ts` — `callJsonWithRepair`: retry-once-with-validation-error, then surface degraded
  (no silent canned fallback).
- `lib/ai.ts` `generateOperatingPlan` now plans from the state bundle (not JSON.stringify(company)),
  uses repair-retry, returns `degraded`; `Cycle.degraded` persisted by `cycles.ts`.

### §3 Self-improvement / skills / MCP
- `lib/self-improvement/goal-reflection.ts` — mines each goal round's per-seat critic outcomes into
  quarantine SKILL drafts (eval-gated promotion already exists; injection behind SKILL_INJECTION_ENABLED,
  now ON). Wired into `runGoalRound`.
- §3.2 client custom skills: `CompanyCustomSkill` model + `lib/custom-skill-store.ts` +
  `app/api/companies/[id]/skills/*` routes + `components/custom-skills-panel.tsx` Settings UI.
  `buildCustomSkillPrelude` in `lib/agent-skill-instructions.ts` prepends enabled, trigger-matched
  skills onto every seat prompt through the same injection path as distilled skills.
- §3.3 client MCP servers: `McpServer` model + `lib/mcp-store.ts` + `lib/mcp-tool-adapter.ts`
  (official `@modelcontextprotocol/sdk` Client over Streamable HTTP / SSE) +
  `app/api/companies/[id]/mcp-servers/*` routes (incl. `/discover`) +
  `components/mcp-servers-panel.tsx`. Every MCP tool defaults to requires-approval; reversible
  tools are an explicit per-server allowlist. Adapters merge into the seat tool registry inside
  `executeStepWithRuntime` (orchestrator-runtime.ts) so MCP calls flow through the durable
  approval/audit spine.

## What's implemented (with dates)
- 2026-06-10: Env brought up (Postgres/Redis in /app, proxy, Claude bridge). §2 Goal Loop full E2E.
  §1 P0-2/P0-3 into cycle planner. §3 reflection loop + skills/MCP schema. tsc clean (0 errors).
- 2026-06-10 (cont.): Fixed `backend/server.py` reverse proxy to preserve duplicate `Set-Cookie`
  headers (was collapsing them in a dict → NextAuth session cookie dropped through the public URL,
  breaking browser login; direct localhost hid it). Login now persists via the public URL.
  Backend verified by testing agent (10/10 goal-loop API tests). Goal cockpit UI renders (SSR markup
  confirmed: goal-cockpit / New goal / Define goal / criteria / rounds). Source download published at
  `public/downloads/trent-progress.zip` (served at `<preview>/downloads/trent-progress.zip`).
- 2026-06-10 (cont. 2): §3.2 + §3.3 surfaces shipped (custom-skill editor, MCP server panel,
  McpToolAdapter wired into the seat tool registry). §1 P0-1 cycle cadence: durable orchestrator
  now produces the cycle report and advances `nextCycleAt` on scheduled run completion
  (orchestrator-run-phases.ts). Repaired duplicate type block + missing identifiers introduced by
  the previous batch edit; `npx tsc --noEmit` clean. Frontend + reverse-proxy HTTP 200. Updated
  download zip (2.6 MB) republished at `<preview>/downloads/trent-progress.zip`.

## Prioritized backlog (next)
- P1: §1 P1-1/P1-3 — model-based typed decomposition emitting Engine-C `Subtask` contracts +
  structured (contract) handoffs; verification stage per `decideEffort` (P2-1).
- P1: §2 Slice 3/4 — engineer "build" steps delegate to the workbench (verified build + screenshots);
  critic consumes workbench verdict/screenshots as evidence.
- P2: SSE "live round" stream so the cockpit shows each seat producing its artifact in real time.
- P2: "Run to completion" one-click that auto-continues rounds within budget until criteria met.
- P2: §2 Slice 6 governance/metrics dashboard.

## Quality bar status (§2.5)
- Met criteria carry an openable evidence artifact. ✅
- Artifact-first: contract-invalid/empty step output fails the step (no prose passes). ✅
- Client custom skills + MCP servers reach seats through the same prelude + adapter spine. ✅
- Engineer build via workbench: pending (currently typed memos; BLOCKED criteria flagged). ⏳
