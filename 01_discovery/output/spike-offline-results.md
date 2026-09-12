# Spike: offline orchestration truth — results

## P1. "Audit log is silently dropped offline" — FALSIFIED (good news, with a narrower real defect)
The orchestrator does NOT use `appendAuditLog`. `orchestrator-run-phases.ts:221` calls
`auditTransition`, implemented at `orchestrator-runtime.ts:1635` as `store.addAudit(...)`, and
`mem-store-state.ts:18-43` re-implements the same SHA-256 chain (`prevHash ?? "genesis"`).
Measured: **28 hash-chained audit rows** in a full offline run.

Narrower real defect: four modules import `appendAuditLog` directly and DO throw with no DATABASE_URL —
`workbench-self-heal.ts:31,45,63`, `skill-foundry.ts:363`, `orchestration-golden-capture.ts:110,159`,
`agent-mission-audit.ts:14`. The CLI must route through `store.addAudit` or avoid those surfaces.

## P2. "Queue fallback double-processes" — VERIFIED. Severe, and silent.
`queue.ts:189` enables the inline fallback whenever `NODE_ENV !== "test"` AND
`TRENT_QUEUE_FALLBACK !== "disabled"` — exactly the state a compiled binary is in. `:203` fires it via
`setTimeout`, which then RACES an explicit drain loop.

Measured on a 3-step run with CLI-like env:
| metric | default env | `TRENT_QUEUE_FALLBACK=disabled` |
|---|---|---|
| worker job invocations | **31** | 5 |
| jobs executed twice | **13** | 0 |
| step_start events | **13** (s1 x3, s2 x5, s3 x5) | 3 |
| run_done emitted | **10x** | 1x |
| error markers on stderr | **0** | 0 |
| reported status | `completed` | `completed` |

It reports success either way. A naive CLI would silently bill roughly 4x the model calls.
`TRENT_EVAL_SYNC_QUEUE=1` does NOT fix it — still fire-and-forget, still double-runs against a drain.

## P3. "Auth silently disabled without a DB" — VERIFIED. This is a security bug in the EXISTING app.
- `CLAUDE.md:65` claims: *"canAccessCompany returns true in NODE_ENV=development."*
- `session.ts:51` actually reads: `if (!process.env.DATABASE_URL) return true;`
- `NODE_ENV` is never referenced in session.ts at all.

**Consequence: a production deploy with NODE_ENV=production but a missing or misnamed DATABASE_URL
grants every authenticated user access to every company.** The same `!DATABASE_URL` early return
repeats at `session.ts:65` (owner membership no-ops) and `:88` (getUserCompanyIds returns null, so
callers fall back to `store.listCompanies()`).

Related: `with-rls.ts:21` computes `IS_POSTGRES` at MODULE LOAD, so RLS cannot be re-enabled at runtime.
`rate-limit.ts:21-23` returns `{ok:true}` on Redis ABSENCE before the try block is reachable, so
`checkAuthRateLimit` fails OPEN on both absence and error — contradicting CLAUDE.md's "fails closed".

ICM principle 8 (improve the source, not only the output): this needs a fix in the app and a
correction to CLAUDE.md. It is out of scope for the CLI work but must be reported, not absorbed.

## The env contract a standalone CLI MUST set
| var | value | why |
|---|---|---|
| `TRENT_QUEUE_FALLBACK` | `disabled` | **required** — otherwise every job runs twice |
| `TRENT_EVAL_SYNC_QUEUE` | unset | still fire-and-forget; double-runs against a drain |
| `DATABASE_URL` | unset (deliberate) | selects memStore + the working hash chain |
| `REDIS_URL` and Upstash vars | unset | forces the null-queue path |
| `NODE_ENV` | irrelevant once the fallback is disabled | do NOT rely on `test` as the switch |

Plus: **the CLI must implement the drain loop itself.** Nothing in `lib/` does this outside the eval
harness (`orchestration-eval-integration.ts:124-143`).

## Verified offline end-to-end (mock providers, fallback disabled)
Terminal state `run_done`; 3 steps all completed; 2 distinct agent roles (ceo, engineer); clean event
sequence; 0 stderr lines; 28 audit rows. **The headline claim holds — a real multi-agent run completes
with no Postgres and no Redis — but only under an env contract the binary does not get by default.**
