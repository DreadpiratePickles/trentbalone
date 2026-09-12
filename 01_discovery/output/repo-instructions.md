# Repo instruction files — authoritative constraints (Stage 00)

Source: `apps/web/CLAUDE.md` (191 lines), `apps/web/AGENTS.md` (47 lines). These are the pre-existing
project's own rules and OUTRANK the v1 spec documents wherever they conflict.

## Hard rules inherited from the existing app
- Files under 500 lines; split if larger.
- `npm run typecheck` before committing.
- IDs via `makeId("prefix")`, timestamps via `nowIso()`.
- Never commit secrets; local secrets in `.env.local`.
- Do what has been asked; nothing more, nothing less.
- Project already follows Superpowers; plans live in `docs/superpowers/plans/`, specs in `docs/superpowers/specs/`.

## Security invariants that the CLI must not break
- Tenant data access must be wrapped in `withRlsContext(companyId, fn)` from `lib/with-rls.ts`.
  On Postgres it sets `app.current_company_id` for RLS; **on SQLite it is a no-op**.
- `checkAuthRateLimit` fails CLOSED. `checkRateLimit`/`checkCycleRateLimit` fail open. Do not change.
- `assertToolSpendAllowed` reserves full `estimatedCents` (TOCTOU guard). Final charge reconciles it.
- `appendAuditLog` uses a serializable transaction; do not split hash-read and row-create.
- `canAccessCompany` returns true when `NODE_ENV=development` — the CLI must never ship that default.
- Secrets rotation via `rekeySecret(ciphertext, oldKey, newKey)` in `lib/secrets.ts`.

## Findings that change the architecture
1. **Dual-database support already exists.** CLAUDE.md states RLS is a Postgres behavior and a no-op on
   SQLite, and AGENTS.md references `trent.db` / `trent-test.db`. Standalone SQLite mode is therefore
   likely a configuration path that already exists, not something to invent. (Confirm in baseline report.)
2. **A `store.*` abstraction exists** (`store.listTasks(companyId)` etc.) — this is the persistence port and
   the natural dependency-injection seam for `@trent/core`.
3. **`TRENT_PLATFORM_DOMAIN` defaults to `trent.app`** — consistent with the installer URL in the plan.
4. **Provisioning is code-complete but unvalidated** against real provider accounts; out of scope for the
   CLI work but must not be regressed.

## Consequence for the design
`@trent/core` wraps `lib/` **through the existing ports** (`store`, `withRlsContext`, model gateway) rather
than reaching around them. Any wrapper that bypasses `withRlsContext` for tenant data is a security
regression and must be rejected in code review.
