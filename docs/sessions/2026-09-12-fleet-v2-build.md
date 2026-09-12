# 2026-09-12 — Trent Fleet v2 build (Master Prompt v2 + Implementation Plan v2)

## Governing documents
- `~/Downloads/Trent Fleet Master Prompt v2.md` — identity, model routing, 10 anti-patterns, 7 superpowers phases, ICM overlay, 13 coding rules, completion criteria.
- `~/Downloads/Trent Fleet Implementation Plan v2.md` — ICM stage contracts, Stages 00-14.
- `apps/web/CLAUDE.md` + `apps/web/AGENTS.md` — the pre-existing app's own rules. These OUTRANK the v1 spec docs.
- Prior audit: `docs/sessions/2026-09-12-antigravity-audit.md`.

## Rules in force
Fable/top model orchestrates; Opus subagents execute. Max 6 agents concurrently. No code before design approval (hard gate, stated in both the prompt and the brainstorming skill). Failing test first. Explicit-file staging. No push/merge/deploy without authorization.

## Stage 00 — Discovery and Baseline (IN PROGRESS)

### Completed
- ICM workspace created: `01_discovery/` through `05_release/`, each with `output/`.
- **Design tokens extracted** from `apps/web/app/styles/base.css` -> `01_discovery/output/design-tokens.json`.
  obsidian #0A0A0F, ink #11111A, steel #1B1B26, slate #262633, haze #4A4A57, mist #94A3B8,
  bone #F1ECE2, bone-2 #E6E0D3, pulse #6EE7B7, pulse-deep #10B981, ember #FB923C, ember-deep #EA580C,
  danger #F87171. Fonts Inter / JetBrains Mono / Instrument Serif. Radii 6/14/22/32.
  The v1 docs' #8B5CF6 purple and #0F1117 are NOT the app's tokens and are forbidden (anti-pattern #5).
- Baseline commit recorded: `ed94ae8ea7297a3a86e7bf96c59539e578d11f2b` (single squashed commit, no remote).
- **Repo instruction constraints** captured -> `01_discovery/output/repo-instructions.md`.
  Files <500 lines; `npm run typecheck` before commit; `makeId()`/`nowIso()`; withRlsContext for tenant
  data (no-op on SQLite); auth rate limit fails CLOSED; spend reservation is a TOCTOU guard; audit log
  is a serializable transaction. **The app already supports both Postgres and SQLite.**
- **Model gateway contract** -> `01_discovery/output/model-gateway-contract.md`.
  The streaming core is CLI-safe: model-gateway -> ai-client -> model-policy import only node:crypto,
  openai, zod. Real streaming entry is `routeWorkbenchStream` + `streamArtifactWithFallback` ->
  `streamAnthropicMessages` / `streamOpenAiCompatibleChat`. Five traps documented, chief among them:
  `MODELS`/`MAX_TOKENS` freeze at import time, so secrets must reach `process.env` before the import;
  and `ai-proxy/openai-compatible.ts:93` returns a CANNED response, so the CLI must never route through it.
- **lib/ wrapping matrix** -> `01_discovery/output/lib-wrapping-matrix.md`.
  4 modules import clean, 2 need only an LLM adapter (both have `skipLLM`), 3 need a DB.
  8+ wrappable, so anti-pattern #2 is satisfiable. 13 Prisma models total, but only 4 tables
  (agentTrace, skillDraft, selfImprovementIteration, auditLog) are needed for the self-improvement loop.

### Pre-existing bug found (report, do not silently fix)
`apps/web/lib/heartbeat.ts:335-336` builds fresh in-memory stores for the sweep inside
`runCompanyHeartbeat`, so the production self-improvement sweep always reads an empty trace store.

### Still running (Opus agents)
orchestrator contract; baseline build/test + Prisma-SQLite feasibility; git-history restoration plan;
Bun-compile + Tauri v2 feasibility; web visual-language + brand assets.

### Next
Synthesize all seven discovery reports -> `01_discovery/output/codebase-audit.json`, then Stage 01:
present 2-3 approaches and the design for approval. No code until approved.

### Baseline verified (executable evidence)
| command | result |
|---|---|
| `cd apps/web && npx next build` | **exit 0** |
| `cd apps/web && npm test` | **exit 0** — 505 files / 2743 tests passed, 125 skipped |
| root `npx vitest run` | exit 1 — 2 phantom failures; root config sweeps apps/web tests without their setup file. **Do not use as the gate.** |
| `prisma validate` on a sqlite-flipped copy | "valid" — `migrate diff` emits 64 CREATE TABLEs + 95 indexes |

Environment: node v26.8.2 (apps/web engines declares 22.x), npm 11.19.1, cargo 1.75.0.
**bun is NOT installed. Docker is installed but the daemon is NOT running** (`docker info` exits 1),
which blocks live Docker-backend tests on this machine.

### Persistence decision input
SQLite is viable with zero schema incompatibilities: 0 `@db.*`, 0 `Unsupported()`, 0 scalar arrays,
0 Decimal/BigInt/Bytes (money is Int cents), no pgvector/citext/full-text. Runtime caveats only:
no JSON-path filtering, no `mode:"insensitive"`, no concurrent writers.
Recommended: generate `schema.sqlite.prisma` from the canonical schema via script so it cannot drift.

Hazard: `apps/web/lib/db.ts:11` assigns `globalThis.__prisma` whenever NODE_ENV !== production, so a
CLI importing it inherits the web singleton and cannot point a second client at SQLite in-process.
The CLI needs its own client factory.

### Orchestrator (major finding)
No Postgres and no Redis required — `store.ts:11` falls back to memStore, `queue.ts:669` runs jobs
inline. DI seam already exists at `lib/runtime-eval-overrides.ts`, and
`lib/orchestration-eval-integration.ts:29` is production code that launches and drains a run.
**There is no `runOrchestration()`** — the plan's assumed API is one our wrapper must create.
20 event kinds on an in-process bus (`subscribeOrcEvents`) drive the CLI's live agent lines.

### Credential blocker
`~/.trent/.env` holds a 16-character placeholder Anthropic key. Doctor reported it green — more
evidence for anti-pattern #8. User must supply a real key for the two live-model tests; everything
else proceeds offline.
