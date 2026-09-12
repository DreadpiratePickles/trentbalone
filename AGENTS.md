# AGENTS.md — Trent Fleet workspace identity (ICM Layer 0)

> Where am I? What may I never do? Where do I go next?

## Purpose
Trent Fleet is a hybrid AI cofounder platform: **CLI + TUI + Desktop + Web** over an existing Next.js 15
application that already contains a multi-agent orchestrator, 164 specialist agents, a self-improvement
loop, and a governance layer. The job is to add delivery surfaces by **wrapping** that application,
never by rewriting it.

Routing lives in `CONTEXT.md`. Each numbered stage owns its own contract in `<stage>/CONTEXT.md`.

## Global invariants — violating any of these fails the work
1. **`apps/web/` is READ ONLY.** Wrap it in `packages/trent-core/`. The one exception is a bug fixed
   deliberately, in its own commit, with a test.
2. **No canned responses.** Every surface calls the real model gateway. If a user types "hello" and gets
   a pre-written string, the work has failed.
3. **`@trent/core` must import at least 8 real `lib/` modules.** Currently targeted: 12.
4. **Failing test first.** RED, watch it fail for the right reason, minimal GREEN, refactor, commit.
   A test that asserts a hard-coded string is not a test.
5. **No claim without an exact command and its exit code.** "Looks correct" is not evidence.
   Never say done, working, or production-ready without one.
6. **Explicit-file staging only.** Never `git add .`. Small commits, one hypothesis each.
   Never push, merge, deploy or publish without explicit authorization.
7. **Secrets never enter logs, commits, memory or chat.** Record where a secret lives, never its value.
8. **Design tokens come from `apps/web/brand/DESIGN_PROMPT.md` and `app/styles/base.css`.**
   Never invent colours. There is no purple in this product.

## The standalone environment contract — non-negotiable
Measured, not assumed. Without the first line, **every job runs twice** and still reports success:
```
TRENT_QUEUE_FALLBACK=disabled      # required; omitting it ~4x the model bill, silently
TRENT_EVAL_SYNC_QUEUE              # must stay unset
REDIS_URL                          # unset
DATABASE_URL                       # local SQLite in standalone; Postgres in connected mode
```
The CLI owns its own job drain loop. Nothing in `lib/` provides one outside the eval harness.

## Verification gate
`cd apps/web && npm test` -> exit 0 (505 files, 2743 tests).
The **root** `vitest run` is misconfigured and yields two phantom failures. Never use it as the gate.

## Model routing
Top model orchestrates and synthesizes. Opus subagents read, analyse and implement. Fable is reserved
for genuinely high-reasoning work such as independent review. **Maximum 6 subagents at any time.**
The orchestrator does not do bulk reading or grunt work while agents are running.

## Inherited rules from the pre-existing app (`apps/web/CLAUDE.md`)
Files under 500 lines. `npm run typecheck` before committing. `makeId("prefix")` and `nowIso()`.
Money is **integer cents**, never floats. Tenant data access goes through `withRlsContext`.
`checkAuthRateLimit` must fail closed. The audit log is a serializable transaction.

## Known pre-existing defects — report, do not silently absorb
1. `apps/web/lib/session.ts:51` returns `true` when `DATABASE_URL` is unset, so a production deploy with
   a missing or misnamed database URL grants every authenticated user access to every company.
   `CLAUDE.md:65` misdescribes this as an `NODE_ENV=development` bypass.
2. `apps/web/lib/rate-limit.ts:21` returns ok on Redis **absence** before the try block, so
   `checkAuthRateLimit` fails **open**, contradicting the documentation.
3. `apps/web/next.config.ts` `outputFileTracingRoot: process.cwd()` is wrong for this hoisted monorepo;
   standalone builds ship with no dependencies.
4. `apps/web/lib/heartbeat.ts:335-336` builds fresh in-memory stores, so the production
   self-improvement sweep is a no-op.
