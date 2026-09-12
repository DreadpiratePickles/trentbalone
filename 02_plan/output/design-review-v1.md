# Independent design review — verdict: NOT APPROVABLE as written

Reviewer: separate Fable agent (ICM principle 7 — no creator grades its own work).
Reviewed: `docs/superpowers/specs/2026-09-12-trent-fleet-v2-design.md`.
4 CRITICAL, 10 MAJOR, 8 MINOR.

## CRITICAL — must be resolved before approval

**C-1. The audit log is silently dropped in standalone mode.**
`apps/web/lib/audit-log.ts:2` imports the Prisma `db` directly with NO memStore fallback, and callers
swallow it — `orchestrator-run-phases.ts:240` wraps `recordHandoff` in `.catch(() => undefined)`.
So with DATABASE_URL unset, every hash-chained audit write throws and vanishes. CLAUDE.md names the
audit log a security invariant. The design sold this as "zero setup, already works".
Also implicated: `session.ts:51` `canAccessCompany` appears to bypass when DATABASE_URL is unset (not
merely when NODE_ENV=development as CLAUDE.md claims), `with-rls.ts` is a no-op, and
`rate-limit.ts:15-42` may return ok on Redis ABSENCE rather than failing closed.
-> Under falsification spike now. If confirmed, ICM principle 8 says fix at the source doc + code.

**C-2. `trent serve` inside a compiled binary was never tested.**
The desktop plan spawns the Bun-compiled binary as a sidecar serving Next.js 15. Nothing in discovery
tested Next.js under `bun --compile`. If it fails, either the desktop ships a Node runtime (killing the
zero-dependency claim) or the sidecar is a different artifact. -> Under falsification spike now.

**C-3. `--continue` cannot resume a run.**
Orchestration state lives in memStore plus `orchestrator-cache.ts:4` (`globalThis`). Kill the process
mid-DAG and the run, steps, pending Approval and JobRun rows all vanish; SQLite would hold only the
chat transcript. `orchestrator-run-reconcile.ts` exists to rehydrate from a durable store and the
design gives it nothing to read. Either persist OrchestratorRun/Step/Event/Approval/JobRun (6 tables,
not the 4 assumed), or state plainly that a standalone run is not resumable.

**C-4. No explicit wrapper table.** Anti-pattern #2 requires >= 8 named `lib/` files imported. The
design lists wrapper names but never maps them to files, and omits agent-marketplace and
orchestration-golden-capture.

## MAJOR — selected
- Kept `SessionStore.ts:32` stores cost as float dollars; the web app uses integer cents everywhere
  (coding rule 4). Design also contradicts itself: §3.2 replaces the session store, §3.5 keeps it.
- `ConfigManager` and `SessionStore` use bare `writeFileSync` — no atomic write-then-rename (rule 7).
- `IdempotencyManager` is an in-memory Map; an idempotency guard that forgets on restart is not one.
- `FixRunner` has zero direct tests; `DoctorRunner.test.ts:30-44` only asserts 12 category strings exist.
- Two budget ledgers: `spend.ts:76-84` reads `store.listUsage` while the CLI ticker would sum gateway
  estimates. Name one writer and one reader.
- Two CLI instances: bun:sqlite needs explicit WAL + busy_timeout; config.yaml needs a lock.
- Doctor's database check must be defined per mode (PRAGMA integrity_check standalone, health endpoint
  connected) or it has nothing real to inspect.
- Missing entirely: error taxonomy + exit codes, telemetry/redaction (session transcripts are written
  to `~/.trent/sessions/*.json` in plaintext with no permissions), `~/.trent` schema version +
  migration + uninstall, Windows story, offline-degraded banner.
- Salvage list overstated: only 3 of 8 keep cleanly (SecurityScan/SkillLoader, LocalBackend,
  TokenManager-with-added-expiry-tests). ConfigManager, SessionStore, IdempotencyManager and FixRunner
  should be rebuilt; personalities keep the manager but drop built-ins that violate the brand voice.

## Build-order change accepted
**Doctor + setup move BEFORE the REPL.** The REPL's first live test is `skipIf(!ANTHROPIC_API_KEY)`,
so without a setup that writes a real key and a doctor that PROVES it with an authenticated call, the
live test silently skips and we would believe the step was green. That is precisely the failure mode
discovery already caught (placeholder key, green doctor).
**Insert falsification spikes as step 0** — running now.

## The predicted failure mode, quoted
"The team writes the core factories against memStore, gets a green offline DAG run in vitest, and ships
a REPL whose approval card, budget ticker and `--continue` all appear to work in a single process. Then
the first real user kills the terminal mid-run: the approval vanishes because it lived in a Map, the
resumed session shows a transcript with no run behind it, the budget ticker restarts at zero while the
spend gate still thinks 10000 cents remain, and the audit log has been silently empty since day one.
Every checklist item was ticked, because none of them asks what survives a restart."

**Consequence: the anti-pattern checklist gains a 16th item — "what survives a process restart?"**
