# Trent Fleet v2 — Design (rev 2, post-review, post-spike)

Status: AWAITING APPROVAL. Baseline `ed94ae8`. Evidence: `01_discovery/output/`, review in
`02_plan/output/design-review-v1.md`. Rev 1 was rejected by an independent reviewer; three
falsification spikes then overturned two of rev 1's own decisions.

---

## 1. What changed since rev 1

| rev 1 said | spike found | rev 2 says |
|---|---|---|
| Prisma cannot live in the binary; hand-write a SQLite schema | **FALSE.** `engineType="client"` + a ~90-line bun:sqlite adapter ran real queries, `$transaction` and cascade deletes inside a compiled binary, exit 0, +2.7 MB | Prisma-on-SQLite. One schema. |
| The audit log is silently dropped offline | **FALSE for the orchestrator.** It uses `store.addAudit`; memStore re-implements the SHA-256 chain. 28 chained rows in a real offline run | Keep, but avoid the 4 modules that call `appendAuditLog` directly |
| Desktop = Tauri v2 spawning the compiled binary as `trent serve` | **FALSE on every clause.** Next.js cannot be Bun-compiled (20 unresolved specifiers; `--external` yields a 169 MB binary that 404s its own chunks). Also `trent serve` is already the A2A server | Ship the Bun **runtime** + `.next/standalone/` as Tauri resources. Rename the command to `trent web` |
| (not considered) | **Without `TRENT_QUEUE_FALLBACK=disabled` every job runs twice** — 31 invocations for a 3-step run, `run_done` fired 10x, zero errors logged, status still `completed` | A hard env contract, enforced and tested |

## 2. Non-negotiable env contract (standalone)
`TRENT_QUEUE_FALLBACK=disabled` (**required** — otherwise ~4x the model bill, silently),
`TRENT_EVAL_SYNC_QUEUE` unset, `DATABASE_URL` pointed at local SQLite, `REDIS_URL` unset.
The CLI owns the drain loop; nothing in `lib/` provides one outside the eval harness.
A test must assert exactly one `run_done` per run — that is the regression guard for the 2x bug.

## 3. Architecture

```
apps/cli (Bun-compiled)        apps/desktop (Tauri v2)          apps/web (untouched)
  REPL + Ink TUI                 window -> 127.0.0.1:<random>     Next.js 15
                                 resources: bun runtime +
                                   .next/standalone/
        \_________________ packages/trent-core _________________/
                                   |
        thin re-exports  |  async factories  |  CLI-owned
        traces, evals,   |  model-gateway,   |  config, sessions,
        readiness, mcp,  |  orchestrator,    |  doctor, prisma-sqlite
        agent-catalog,   |  skills, gepa,    |  store, egress, gateway
        marketplace      |  heartbeat sweep  |
                                   |
                        apps/web/lib  (READ ONLY)
```

Wrapped `lib/` files (anti-pattern #2 requires >= 8; this is 12):
model-gateway, orchestrator, orchestrator-runtime, orchestrator-events, agent-catalog, trace-store,
skill-foundry, eval-harness, gepa, readiness-controls, mcp-connector-catalog, agent-marketplace.

Ports: `GatewayPort`, `StorePort`, `TraceSinkPort`, `ApprovalPort`, `AuditPort`.

## 4. Persistence — two modes, one schema
- **Standalone**: Prisma client-engine against `~/.trent/trent.db` via a vendored bun:sqlite adapter.
  `schema.sqlite.prisma` is DERIVED in CI by a two-line datasource swap so it cannot drift.
  Persists OrchestratorRun / Step / Event / Approval / JobRun, so `--continue` resumes a real run.
- **Connected**: HTTP to `trent web`; the server owns Postgres.
- Migrations ship as embedded SQL applied via `executeScript` (the schema engine is not in the binary).
- Risk accepted: the adapter is ours, needs its own suite, re-run on every Prisma bump.

## 5. Build order (reviewer's reorder accepted)
0. Spikes — **done**.
1. Core wrappers + the env contract + the store port.
2. **Doctor and setup FIRST.** The live test is `skipIf(!KEY)`; without a doctor that proves a key with
   a real authenticated call, a skipped test reads as green. That is exactly the placeholder-key trap.
3. REPL on the real gateway: streaming, real cost, Ctrl+C aborts the stream not the process,
   Ctrl+J newline, slash dropdown, blocking approvals.
4. TUI on the same session engine.
5. Installer: staged, checksummed, real download.
6. Desktop: Tauri v2 wrapping the web app.
7. Width: gateway transports, TLS egress, Docker lifecycle, voice, ACP.

## 6. Salvage (approved, tightened by review — 3 of 8 keep clean)
- **Keep**: SecurityScan + SkillLoader, LocalBackend, TokenManager (add expiry/revocation tests).
- **Keep manager, drop built-ins**: personalities (pirate violates the brand voice).
- **Rebuild test-first**: ConfigManager (never writes `process.env`; non-atomic writes; no version key),
  SessionStore (float dollars vs the app's integer cents; non-atomic), IdempotencyManager (in-memory Map
  — a guard that forgets on restart is not a guard), FixRunner (zero direct tests).
- **Rebuild**: REPL, TUI, all gateway adapters, egress proxy, SSH/E2B backends, voice, updater, wizard, desktop.
- **Delete**: `generateAutonomousReply` and every canned-string path.

## 7. Gaps rev 1 omitted (all now in scope)
Error taxonomy + exit codes (0 ok, 2 usage, 3 config, 4 auth, 5 provider, 6 budget, 130 interrupt) and a
JSON error envelope, without which `--json` everywhere is meaningless. Structured logs with no prompt
bodies; session transcripts currently land in `~/.trent/sessions/*.json` in plaintext with no mode set.
`~/.trent` schema version + migration + `trent uninstall`. Windows: build it or scope it out, no middle.
Offline degraded banner — the planner silently falls back to deterministic plans with no key, and that
must never be mistaken for real output. Concurrency: WAL + busy_timeout, a config lock, one
orchestration per process.

## 8. Distribution
Binaries: **GitHub Releases** (free, no size cap, versioned). `agent.let-trent.uk`: DNS record to GitHub
Pages serving `install.sh` over HTTPS — achievable with the DNS-only Cloudflare token we have. R2 would
need a token with R2 edit permission.
Desktop claim is **"no external dependencies to install"**, not "single binary" — true, since Bun is vendored.

## 9. Hermes parity checklist (match, then beat)
Match: staged installer with a machine-readable protocol, banner, wizard run inside the install; 3-mode
setup; interactive model picker; doctor with real checks and a real `--fix`; classic REPL + opt-in TUI;
`--continue`; sessions; skills hub with a security scan and progressive disclosure; toolsets; messaging
gateway with in-chat approvals and pairing; egress credential brokering; ACP; personalities; config split.
Beat: 164 specialists (Hermes has zero), real multi-agent orchestration, the self-improvement loop,
a genuinely single-file CLI (they need Python + uv + Node + ffmpeg + Playwright), one coherent UI
instead of their split classic/TUI, egress ON by default, and a doctor that never hangs.

## 10. Verification
Gate is `cd apps/web && npm test` (exit 0, 2743 tests). The root vitest config is misconfigured — two
phantom failures — and must not be used. Plus the **16th checklist item the reviewer forced:
"what survives a process restart?"**

## 11. Reported, not absorbed — pre-existing bugs in apps/web
1. **Auth fails open.** `session.ts:51` is `if (!process.env.DATABASE_URL) return true;`. CLAUDE.md:65
   claims the bypass is `NODE_ENV=development`; NODE_ENV is never read. A production deploy with a
   missing or misnamed DATABASE_URL grants every authenticated user access to every company.
   Same pattern at `session.ts:65` and `:88`. `with-rls.ts:21` decides at module load. `rate-limit.ts:21`
   returns ok on Redis ABSENCE before the try block, so `checkAuthRateLimit` fails OPEN, contradicting the docs.
2. `next.config.ts` `outputFileTracingRoot: process.cwd()` is wrong for this hoisted monorepo; standalone
   output gets no node_modules and is non-portable.
3. `heartbeat.ts:335-336` builds fresh in-memory stores, so the production self-improvement sweep is a no-op.
4. Four modules call `appendAuditLog` directly and throw with no DATABASE_URL.

These are outside the CLI scope. ICM principle 8 says fix at the source; they need their own task.

---

## 12. Fleet shape and the self-improvement loop (added 2026-09-12 evening)

**Nine seats live at once; the 164 specialists are optional.** The core roles — ceo, engineer, growth,
content, support, analyst, finance, browser, escalation — are always resident. A specialist is installed
on demand (`trent fleet install`) and is only active while installed.

**Consequence for the loop.** Trent already owns the strongest self-improvement pipeline in this
category — trace store -> eval gate -> skill foundry -> GEPA prompt evolution on a Pareto frontier ->
skill health with cascade -> golden-trace capture from failures. Hermes has no prompt evolution and no
eval gate at all. Two facts decide the build:

1. **It never runs today.** `apps/web/lib/heartbeat.ts:335-336` constructs fresh in-memory stores inside
   `runCompanyHeartbeat`, so the production sweep reads an empty trace store and learns nothing. The
   wrapper's `runSelfImprovementSweep` is fully dependency-injected and does not have the bug; the CLI
   calls it directly with the real durable stores.
2. **Scope follows residency.** Improve the nine live seats continuously from every session. Improve a
   specialist only while it is installed and only once it has produced enough traces to clear the
   distill threshold. Never spend a model call evolving a prompt for an agent nobody runs.

Everything Hermes does that we lack is added on top, per the research in
`01_discovery/references/hermes-self-improvement.md` once it lands.
