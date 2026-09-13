# 2026-09-12 — connect the self-improvement loop (branch feature/trent-fleet-v2)

Spec: `01_discovery/references/hermes-self-improvement.md` (ranked recommendations), design doc s12.
Ownership: `packages/trent-core/src/improve/**`, `orchestrator/index.ts`, `store/{StorePort,PrismaStore}.ts`,
`apps/cli/src/commands/improve.ts` + one-line registration. `apps/web/` untouched. No git.

## Decisions
- Store: `StorePort.improve()` -> `ImproveStorePort` (5 tables). SQLite impl is raw SQL through the
  same Prisma connection (`improve/sqlite-store.ts`): the schema is derived from apps/web (read-only),
  so the loop's columns are added idempotently (nullable ALTERs on AgentTrace/SkillDraft/
  SelfImprovementIteration) and GepaFrontier + SkillLedger are new tables. Contract proven on the
  in-memory store (Node) and the real SQLite store (Bun child process), same assertions.
- Bus hook: `createImproveHook({store, installedAgents, goldenDir})` -> `createOrchestrator({ improve })`.
  The wrapper calls `sink` on every event and awaits `flush()` before the run settles; `run_start`
  now carries `companyId`.
- taskType = first four content words of the objective, slugged (`deriveTaskType`).
- Scope: nine seats + `sales` always trace; a specialist only while installed.

## RED (module absent) captured 20:41 for all 9 test files; store + trace + golden GREEN 20:44.

## Built (packages/trent-core/src/improve/, 22 files incl. 9 test files, all < 500 lines)
memory-store, sqlite-store (+sqlite-scenario, store-contract), trace-writer, golden-capture, hook,
suites, gate, ledger, protected-prompt, lifecycle, scope, seat-prompt, gepa-pass, sweep, org-tier,
status, index; CLI `apps/cli/src/commands/improve.ts` (+ one line in commands/index.ts).

## Verification (20:58)
- `npx vitest run packages/trent-core/src/improve packages/trent-core/src/orchestrator packages/trent-core/src/store apps/cli/src/commands`
  -> exit 1: 416 passed, 1 failed = `desktop.test.ts > trent update > installs, verifies --version...`
  (updater binary receipt; not touched by this work, fails alone too). Improve: 35 + 5 CLI tests green.
- `npx tsc --noEmit -p packages/trent-core/tsconfig.json` -> exit 0.
- `npx tsx apps/cli/src/index.ts improve status --json` -> exit 0, `store.durable=false` (bun:sqlite
  under Node, reported honestly); `bun apps/cli/src/index.ts improve status --json` -> durable=true.
- `TRENT_TEST_LIVE=1 npx vitest run .../improve.live.test.ts` -> exit 0, 3 gemini-3.5-flash-lite calls.

## Notes for the parent
- Another agent refactored orchestrator/index.ts (event-channel.ts, seat-guard.ts) concurrently;
  my edits (RunBusHook, deps.improve sink/flush, companyId on run_start) landed on the new file.
- `StorePort.improve?()` is optional so `apps/cli/src/repl/__tests__/harness.ts` MemoryStore still compiles.
- Pre-existing tsc error in apps/cli: `tui/App.tsx(235)` `fixAll` missing on DoctorRunner — not mine.
