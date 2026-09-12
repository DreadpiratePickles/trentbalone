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

---

## Stage 02 — Branch and history restoration (COMPLETE)
- Feature branch `feature/trent-fleet-v2` created off the restored history.
- **Git history restored: 174 commits.** Built in a scratch clone, imported with a single
  `git reset --mixed` (never writes the working tree). Verified: 3236 files matched as exact renames
  (0 adds, 0 deletes), `git log --follow` crosses the move, authors preserved
  (Bobby Meher 159, Claude 12, Codex 1).
- **Recovered 11 source files** the previous agent silently dropped when a new root `.gitignore`
  swallowed the artifacts API routes and their tests. Two needed NUL-delimited handling because of
  em-dash filenames (the macOS unicode hazard).
- Secret sweep across all 174 commits: clean. The one hit, `sk-ant-api03-abcdef987654321`, is a
  fixture inside the OTel redaction test asserting that secrets get stripped.
- Pushed to `DreadpiratePickles/trentbalone` (**private**). Local and remote in sync at 174 commits.
- Machine note: a global `credential.username = test-user` blocked the push; overridden locally only.

## Stage 02b — ICM scaffolding completed (was missing)
A re-read of the two governing documents exposed that I had skipped required artifacts. Now written:
`AGENTS.md` (layer 0), `CONTEXT.md` (layer 1), five stage contracts in the required
Objective/Inputs/Process/Outputs/Verify/Approval/Failure format, `codebase-audit.json`
(14 modules, verbatim signatures, 0 next imports, anti-pattern 2 satisfiable),
`02_plan/output/design-doc.md`, and `implementation-plan.md` (superpowers phase 3, 2-5 minute tasks
each naming the failing test and its expected failure message).

## Stage 03 — Implementation

### Task 1.1 — standalone env contract (COMPLETE, GREEN)
RED first. A guard test forces `NODE_ENV=production` to imitate a compiled binary and **reproduced the
double-execution bug**: `run_done` emitted more than once while the run still reported `completed`.
Without that guard the contract test would pass vacuously, because vitest's own `NODE_ENV=test`
suppresses the fallback. The two contract tests then failed on the missing module — the correct RED.

Implemented `packages/trent-core/src/runtime/env.ts`: `applyStandaloneEnv`, `assertStandaloneEnv`,
`IN_MEMORY_DATABASE`. Note `applyStandaloneEnv(":memory:")` deliberately LEAVES `DATABASE_URL` unset,
because `store.ts:11` selects the Prisma store whenever that variable is present.

| check | command | result |
|---|---|---|
| core runtime tests | `npx vitest run packages/trent-core/src/runtime` | 3 passed |
| regression gate | `cd apps/web && npm test` | 505 files / 2743 tests passed |
| web typecheck | `npm run typecheck` | exit 0 |
| core typecheck | `npx tsc -p packages/trent-core/tsconfig.json` | 0 errors |

Also fixed: `packages/trent-core/tsconfig.json` now MIRRORS `apps/web/tsconfig.json` compilerOptions
(dom lib, bundler resolution, isolatedModules) so files imported from apps/web type-check identically
in both places. Diverging them again will reintroduce phantom errors.

### Tasks 1.2-1.7 — dispatched in parallel (6 Opus agents, at the cap)
1.2 error taxonomy + exit codes + secret-redacting envelope · 1.3 ConfigManager rebuild
(the `loadSecrets` never-writes-process.env bug is the headline) · 1.4 model gateway live streaming
against the verified Gemini key · 1.5 Prisma-on-SQLite store with the vendored bun:sqlite adapter and
a restart-durability test · 1.6 orchestrator wrapper with an owned drain loop · 1.7 wrap the remaining
eight lib modules plus the anti-pattern-2 import-graph test.
Agents do not commit; the orchestrator reviews and commits.
